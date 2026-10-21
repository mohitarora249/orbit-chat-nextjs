import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// iOS rounds the corners itself, so this is the mark from src/app/icon.svg on a full square.
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#18181b" }}>
        <svg viewBox="0 0 32 32" width="180" height="180">
          <circle cx="16" cy="16" r="7.5" fill="none" stroke="#fff" strokeOpacity="0.85" strokeWidth="2.25"/>
          <circle cx="21.3" cy="10.7" r="3.25" fill="#6e87d8" stroke="#18181b" strokeWidth="1.75"/>
        </svg>
      </div>
    ),
    size
  );
}
