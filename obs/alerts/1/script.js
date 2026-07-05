// Get query parameters
const urlParams = new URLSearchParams(window.location.search);
const title = urlParams.get("title") || "This is a test notification.";
const color = urlParams.get("color") || "#380848"; // Default color
const boxAlign = urlParams.get("boxAlign") || "center";

// Update alert box content and style dynamically
document.getElementById("notification-message").innerText = title;

// Update background color of the rectangle
const rectangle = document.querySelector(".rectangle");
const container = document.querySelector(".container");
if (rectangle) rectangle.style.background = color;
if (container) container.classList.add(`box-align-${boxAlign}`);

function applyWidgetMetrics() {
  if (!rectangle) return;
  const h = Math.max(1, window.innerHeight || 0);
  const scale = Math.max(0.35, Math.min(2.25, h / 48));
  const viewport = document.querySelector('meta[name="viewport"]');
  if (viewport) {
    viewport.setAttribute('content', `width=device-width, initial-scale=${scale.toFixed(3)}`);
  }
  document.body.style.zoom = scale.toFixed(3);
  rectangle.style.setProperty('--widget-pad-y', '10px');
  rectangle.style.setProperty('--widget-pad-x', '16px');
  rectangle.style.setProperty('--widget-text-size', '14px');
  rectangle.style.setProperty('--widget-icon-size', '18px');
  rectangle.style.setProperty('--widget-icon-gap', '8px');
}

applyWidgetMetrics();
window.addEventListener('resize', applyWidgetMetrics);
window.addEventListener('load', applyWidgetMetrics);
