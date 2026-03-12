#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import mimetypes
import sys
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, urlparse

import cv2

BUNDLE_DIR = Path(r"C:\Users\seera\Downloads\traffic_model_bundle")
DEFAULT_CONFIG_PATH = BUNDLE_DIR / "configs" / "runtime.yaml"
DEFAULT_VIDEO_PATH = Path(r"C:\Users\seera\Downloads\5927708-hd_1080_1920_30fps.mp4")
DEFAULT_PROCESS_FPS = 10.0
DEFAULT_EMIT_INTERVAL_SEC = 1.0
DEFAULT_REALTIME = True
LANES = ("N", "E", "S", "W")

sys.path.insert(0, str(BUNDLE_DIR))

from traffic_pipeline import TrafficPipeline, load_config  # noqa: E402


def parse_bool(raw_value: Optional[str], default: bool) -> bool:
    if raw_value is None:
        return default
    return raw_value.strip().lower() in {"1", "true", "yes", "on"}


def parse_positive_float(raw_value: Optional[str], default: float, name: str) -> float:
    if raw_value in {None, ""}:
        return default
    value = float(raw_value)
    if value <= 0.0:
        raise ValueError(f"{name} must be greater than 0")
    return value


def parse_non_negative_int(raw_value: Optional[str], default: int, name: str) -> int:
    if raw_value in {None, ""}:
        return default
    value = int(raw_value)
    if value < 0:
        raise ValueError(f"{name} must be 0 or greater")
    return value


def format_timestamp(timestamp_sec: float) -> str:
    total_seconds = max(0, int(round(timestamp_sec)))
    minutes, seconds = divmod(total_seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    return f"{minutes:02d}:{seconds:02d}"


def should_process_frame(
    frame_index: int,
    timestamp_sec: float,
    process_fps: float,
    next_process_timestamp: Optional[float],
) -> tuple[bool, Optional[float]]:
    scheduled_timestamp = 0.0 if next_process_timestamp is None else next_process_timestamp
    if timestamp_sec + 1e-9 < scheduled_timestamp:
        return False, scheduled_timestamp
    return True, scheduled_timestamp + (1.0 / process_fps)


def should_emit_state(
    timestamp_sec: float,
    emit_interval_sec: float,
    next_emit_timestamp: Optional[float],
) -> tuple[bool, Optional[float]]:
    scheduled_timestamp = emit_interval_sec if next_emit_timestamp is None else next_emit_timestamp
    if timestamp_sec + 1e-9 < scheduled_timestamp:
        return False, scheduled_timestamp

    while scheduled_timestamp <= timestamp_sec + 1e-9:
        scheduled_timestamp += emit_interval_sec
    return True, scheduled_timestamp


def load_pipeline(config_path: Path) -> TrafficPipeline:
    config = load_config(str(config_path))
    weights_path = Path(config.detector.weights_path)
    if not weights_path.is_absolute():
        config_relative = (config_path.parent / weights_path).resolve()
        bundle_relative = (BUNDLE_DIR / weights_path).resolve()
        resolved_weights_path = config_relative if config_relative.exists() else bundle_relative
        config.detector.weights_path = str(resolved_weights_path)
    return TrafficPipeline(config)


def build_video_metadata(capture: cv2.VideoCapture, video_path: Path) -> dict[str, object]:
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    duration_sec = round(frame_count / fps, 2) if frame_count and fps else 0.0
    return {
        "path": str(video_path),
        "fps": round(fps, 2),
        "frameCount": frame_count,
        "width": width,
        "height": height,
        "durationSec": duration_sec,
    }


def build_vehicle_details(snapshots) -> list[dict[str, object]]:
    details = []
    for snapshot in snapshots:
        details.append(
            {
                "id": snapshot.track_id,
                "lane": snapshot.lane,
                "className": snapshot.class_name,
                "confidence": round(snapshot.confidence, 3),
                "isHalting": bool(snapshot.is_halting),
                "waitTimeSec": round(snapshot.wait_time, 2),
                "isEmergency": bool(snapshot.is_emergency),
            }
        )
    return details


def build_lane_stats(vehicle_details: list[dict[str, object]]) -> tuple[dict[str, int], dict[str, dict[str, object]]]:
    lane_distribution = {lane: 0 for lane in LANES}
    lane_stats: dict[str, dict[str, object]] = {
        lane: {
            "vehicles": 0,
            "halting": 0,
            "ambulances": 0,
            "emergencyVehicles": 0,
            "totalWaitTimeSec": 0.0,
            "averageWaitTimeSec": 0.0,
        }
        for lane in LANES
    }

    for vehicle in vehicle_details:
        lane = vehicle["lane"]
        lane_distribution[lane] = lane_distribution.get(lane, 0) + 1
        lane_entry = lane_stats.setdefault(
            lane,
            {
                "vehicles": 0,
                "halting": 0,
                "ambulances": 0,
                "emergencyVehicles": 0,
                "totalWaitTimeSec": 0.0,
                "averageWaitTimeSec": 0.0,
            },
        )
        lane_entry["vehicles"] += 1
        if vehicle["isHalting"]:
            lane_entry["halting"] += 1
        if vehicle["isEmergency"]:
            lane_entry["emergencyVehicles"] += 1
        if "ambulance" in str(vehicle["className"]).lower():
            lane_entry["ambulances"] += 1
        lane_entry["totalWaitTimeSec"] += float(vehicle["waitTimeSec"])

    for lane, lane_entry in lane_stats.items():
        count = lane_entry["vehicles"]
        total_wait = lane_entry["totalWaitTimeSec"]
        lane_entry["totalWaitTimeSec"] = round(total_wait, 2)
        lane_entry["averageWaitTimeSec"] = round(total_wait / count, 2) if count else 0.0

    return lane_distribution, lane_stats


def build_analysis_payload(
    result: dict[str, object],
    *,
    emitted_index: int,
    timestamp_sec: float,
) -> dict[str, object]:
    snapshots = result.get("snapshots", [])
    vehicles = list(result.get("vehicles", []))
    vehicle_details = build_vehicle_details(snapshots)
    lane_distribution, lane_stats = build_lane_stats(vehicle_details)

    total_vehicles = len(vehicle_details)
    halting_vehicles = sum(1 for vehicle in vehicle_details if vehicle["isHalting"])
    emergency_vehicles = sum(1 for vehicle in vehicle_details if vehicle["isEmergency"])
    ambulance_count = sum(
        1 for vehicle in vehicle_details if "ambulance" in str(vehicle["className"]).lower()
    )
    total_wait_time = sum(float(vehicle["waitTimeSec"]) for vehicle in vehicle_details)
    halting_wait_time = sum(
        float(vehicle["waitTimeSec"]) for vehicle in vehicle_details if vehicle["isHalting"]
    )

    metrics = {
        "totalVehicles": total_vehicles,
        "ambulanceCount": ambulance_count,
        "emergencyVehicleCount": emergency_vehicles,
        "haltingVehicleCount": halting_vehicles,
        "movingVehicleCount": max(0, total_vehicles - halting_vehicles),
        "averageWaitTimeSec": round(total_wait_time / total_vehicles, 2) if total_vehicles else 0.0,
        "averageHaltingWaitTimeSec": round(halting_wait_time / halting_vehicles, 2)
        if halting_vehicles
        else 0.0,
        "laneDistribution": lane_distribution,
        "laneStats": lane_stats,
        "currentGreenLane": result.get("current_green_lane"),
        "signalCycleTimeSec": round(
            float(result.get("signal_plan", {}).get("total_cycle_time", 0.0))
            if result.get("signal_plan")
            else 0.0,
            2,
        ),
    }

    return {
        "type": "analysis",
        "emittedIndex": emitted_index,
        "timestampSec": round(timestamp_sec, 2),
        "timestampLabel": format_timestamp(timestamp_sec),
        "vehicles": vehicles,
        "vehicleDetails": vehicle_details,
        "metrics": metrics,
        "signalPlan": result.get("signal_plan"),
    }


def resolve_existing_path(raw_path: Optional[str], fallback: Path, kind: str) -> Path:
    candidate = Path(raw_path).expanduser() if raw_path else fallback
    if not candidate.exists():
        raise FileNotFoundError(f"{kind} was not found: {candidate}")
    return candidate.resolve()


def json_bytes(payload: dict[str, object]) -> bytes:
    return json.dumps(payload).encode("utf-8")


class TrafficDashboardHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "TrafficDashboard/1.0"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[traffic-dashboard] {self.address_string()} - {fmt % args}")

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self._write_json({"status": "ok"})
            return
        if parsed.path == "/api/config":
            self._handle_config()
            return
        if parsed.path == "/api/stream":
            self._handle_stream(parsed.query)
            return
        if parsed.path == "/api/video":
            self._handle_video(parsed.query)
            return
        self._write_json(
            {
                "error": "Not found",
                "path": parsed.path,
            },
            status=HTTPStatus.NOT_FOUND,
        )

    def _handle_config(self) -> None:
        try:
            capture = cv2.VideoCapture(str(DEFAULT_VIDEO_PATH))
            video = build_video_metadata(capture, DEFAULT_VIDEO_PATH) if capture.isOpened() else None
        finally:
            capture.release()

        self._write_json(
            {
                "bundlePath": str(BUNDLE_DIR),
                "configPath": str(DEFAULT_CONFIG_PATH),
                "defaultVideoPath": str(DEFAULT_VIDEO_PATH),
                "defaults": {
                    "processFps": DEFAULT_PROCESS_FPS,
                    "emitIntervalSec": DEFAULT_EMIT_INTERVAL_SEC,
                    "realtime": DEFAULT_REALTIME,
                },
                "lanes": list(LANES),
                "video": video,
            }
        )

    def _handle_stream(self, raw_query: str) -> None:
        query = parse_qs(raw_query)
        try:
            video_path = resolve_existing_path(query.get("videoPath", [None])[0], DEFAULT_VIDEO_PATH, "Video")
            config_path = resolve_existing_path(
                query.get("configPath", [None])[0],
                DEFAULT_CONFIG_PATH,
                "Config",
            )
            emit_interval_sec = parse_positive_float(
                query.get("emitIntervalSec", [None])[0],
                DEFAULT_EMIT_INTERVAL_SEC,
                "emitIntervalSec",
            )
            process_fps = parse_positive_float(
                query.get("processFps", [None])[0],
                DEFAULT_PROCESS_FPS,
                "processFps",
            )
            max_emits = parse_non_negative_int(
                query.get("maxEmits", [None])[0],
                0,
                "maxEmits",
            )
            realtime = parse_bool(query.get("realtime", [None])[0], DEFAULT_REALTIME)
        except (FileNotFoundError, ValueError) as exc:
            self._write_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            return

        try:
            pipeline = load_pipeline(config_path)
            capture = cv2.VideoCapture(str(video_path))
            if not capture.isOpened():
                raise RuntimeError(f"Could not open source: {video_path}")
        except Exception as exc:
            self._write_json({"error": str(exc)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        try:
            fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
            self._write_sse(
                {
                    "type": "session",
                    "video": build_video_metadata(capture, video_path),
                    "videoPath": str(video_path),
                    "configPath": str(config_path),
                    "processFps": process_fps,
                    "emitIntervalSec": emit_interval_sec,
                    "realtime": realtime,
                }
            )

            frame_index = -1
            next_process_timestamp: Optional[float] = None
            next_emit_timestamp: Optional[float] = None
            latest_result: Optional[dict[str, object]] = None
            latest_timestamp = 0.0
            emitted = 0
            stream_started_at = time.perf_counter()

            while True:
                ok, frame = capture.read()
                if not ok:
                    break

                frame_index += 1
                timestamp_sec = capture.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
                if timestamp_sec <= 0.0:
                    timestamp_sec = frame_index / fps

                process_now, next_process_timestamp = should_process_frame(
                    frame_index=frame_index,
                    timestamp_sec=timestamp_sec,
                    process_fps=process_fps,
                    next_process_timestamp=next_process_timestamp,
                )
                if not process_now:
                    continue

                latest_result = pipeline.process_frame(frame, timestamp_sec=timestamp_sec)
                latest_timestamp = timestamp_sec

                emit_now, next_emit_timestamp = should_emit_state(
                    timestamp_sec=timestamp_sec,
                    emit_interval_sec=emit_interval_sec,
                    next_emit_timestamp=next_emit_timestamp,
                )
                if not emit_now:
                    continue

                emitted += 1
                payload = build_analysis_payload(
                    latest_result,
                    emitted_index=emitted,
                    timestamp_sec=timestamp_sec,
                )
                self._write_sse(payload)

                if realtime:
                    target_elapsed = emitted * emit_interval_sec
                    remaining = target_elapsed - (time.perf_counter() - stream_started_at)
                    if remaining > 0:
                        time.sleep(remaining)

                if max_emits and emitted >= max_emits:
                    break

            self._write_sse(
                {
                    "type": "complete",
                    "emittedCount": emitted,
                    "lastTimestampSec": round(latest_timestamp, 2),
                    "lastTimestampLabel": format_timestamp(latest_timestamp),
                    "finalFrame": None
                    if latest_result is None
                    else build_analysis_payload(
                        latest_result,
                        emitted_index=emitted,
                        timestamp_sec=latest_timestamp,
                    ),
                }
            )
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as exc:
            self._write_sse({"type": "error", "message": str(exc)})
        finally:
            capture.release()

    def _handle_video(self, raw_query: str) -> None:
        query = parse_qs(raw_query)
        try:
            video_path = resolve_existing_path(query.get("path", [None])[0], DEFAULT_VIDEO_PATH, "Video")
        except FileNotFoundError as exc:
            self._write_json({"error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            return

        file_size = video_path.stat().st_size
        content_type = mimetypes.guess_type(video_path.name)[0] or "application/octet-stream"
        range_header = self.headers.get("Range")
        start = 0
        end = file_size - 1
        status = HTTPStatus.OK

        if range_header and range_header.startswith("bytes="):
            start_str, _, end_str = range_header[6:].partition("-")
            if start_str:
                start = int(start_str)
            if end_str:
                end = int(end_str)
            end = min(end, file_size - 1)
            if start > end or start >= file_size:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{file_size}")
                self.end_headers()
                return
            status = HTTPStatus.PARTIAL_CONTENT

        content_length = (end - start) + 1
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(content_length))
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.end_headers()

        with video_path.open("rb") as handle:
            handle.seek(start)
            remaining = content_length
            while remaining > 0:
                chunk = handle.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def _write_json(self, payload: dict[str, object], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _write_sse(self, payload: dict[str, object]) -> None:
        body = f"data: {json.dumps(payload)}\n\n".encode("utf-8")
        self.wfile.write(body)
        self.wfile.flush()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve traffic analysis for the React dashboard.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address.")
    parser.add_argument("--port", type=int, default=8000, help="Bind port.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    server = ThreadingHTTPServer((args.host, args.port), TrafficDashboardHandler)
    print(f"Traffic dashboard backend listening on http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
