# Intellient_Traffic_management

Interactive traffic management dashboard built with React and a local YOLO-based analysis backend.

##Demo Video

<video controls width="600">
  <source src="DIRECT_VIDEO_URL.mp4" type="video/mp4">
</video>

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
