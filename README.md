# Intellient_Traffic_management

Interactive traffic management dashboard built with React and a local YOLO-based analysis backend.

## Demo Video

<p align="center">
  <a href="https://www.youtube.com/watch?v=ndheRcY9i64">
    <img src="https://img.youtube.com/vi/ndheRcY9i64/maxresdefault.jpg" width="700">
  </a>
</p>

## Features

- Streams per-second vehicle JSON from a local video source
- Tracks total vehicles, ambulances, halting vehicles, and wait times
- Breaks lane distribution down across north, east, south, and west
- Serves a local video preview and SSE analysis feed

## Local Run

```powershell
npm run start:backend
npm start
```
