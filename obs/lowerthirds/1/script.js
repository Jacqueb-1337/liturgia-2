// Get query parameters
const urlParams = new URLSearchParams(window.location.search);
const name = urlParams.get("name") || "John Doe";
const title = urlParams.get("title") || "Software Engineer";
const primaryColor = urlParams.get("primary") || "#1a1a2e"; // Main background color
const secondaryColor = urlParams.get("secondary") || "#0f3460"; // Secondary background
const accentColor = urlParams.get("accent") || "#e94560"; // Accent line color
const textColor = urlParams.get("text") || "#ffffff"; // Primary text color
const textSecondary = urlParams.get("textsecondary") || "#b8bcc8"; // Secondary text color
const animation = urlParams.get("animation") || "slide"; // Animation type: slide, fade, scale
const theme = urlParams.get("theme") || "default"; // Theme: default, minimal, modern, broadcast
const position = urlParams.get("position") || "bottomleft"; // Position: bottomleft, topleft, bottomright, topright
const style = urlParams.get("style") || "1"; // Style: 1 (default), 2 (stripe), 3 (gradient), 4 (glass-dark), 5 (glass-light), 6 (corporate), 7 (cyberpunk)
const timeout = urlParams.get("timeout") || null; // Timeout: e.g., "30", "120s", "2m"
const boxAlign = urlParams.get("boxAlign") || "center"; // Left, center, right within the widget box

// Update lower third content and style dynamically
document.getElementById("person-name").innerText = name;
document.getElementById("person-title").innerText = title;

// Update colors
const lowerThird = document.querySelector(".lower-third");
const container = document.querySelector(".container");
container.classList.add(`box-align-${boxAlign}`);

function applyWidgetMetrics() {
  if (!lowerThird) return;
  const h = Math.max(1, window.innerHeight || 0);
  const scale = Math.max(0.35, Math.min(2.25, h / 86));
  const viewport = document.querySelector('meta[name="viewport"]');
  if (viewport) {
    viewport.setAttribute('content', `width=device-width, initial-scale=${scale.toFixed(3)}`);
  }
  document.body.style.zoom = scale.toFixed(3);
  lowerThird.style.setProperty('--widget-pad-x', '32px');
  lowerThird.style.setProperty('--widget-pad-x2', '24px');
  lowerThird.style.setProperty('--widget-pad-top', '16px');
  lowerThird.style.setProperty('--widget-title-gap', '4px');
  lowerThird.style.setProperty('--widget-pad-bottom', '16px');
  lowerThird.style.setProperty('--widget-name-size', '22px');
  lowerThird.style.setProperty('--widget-title-size', '16px');
}

lowerThird.style.setProperty("--primary-color", primaryColor);
lowerThird.style.setProperty("--secondary-color", secondaryColor);
lowerThird.style.setProperty("--accent-color", accentColor);
lowerThird.style.setProperty("--text-color", textColor);
lowerThird.style.setProperty("--text-secondary", textSecondary);

// Apply animation class
lowerThird.classList.add(`animation-${animation}`);

// Apply theme class
if (theme !== "default") {
  lowerThird.classList.add(`theme-${theme}`);
}

// Apply position class
container.classList.add(`position-${position}`);

// Apply style class
if (style !== "1") {
  const styleMap = {
    "2": "neon",
    "3": "retro", 
    "4": "glass",
    "5": "glass-light",
    "6": "corporate",
    "7": "cyberpunk"
  };
  
  if (styleMap[style]) {
    lowerThird.classList.add(`style-${styleMap[style]}`);
  }
}

applyWidgetMetrics();
window.addEventListener('resize', applyWidgetMetrics);
window.addEventListener('load', applyWidgetMetrics);

// Handle timeout functionality
if (timeout) {
  let timeoutSeconds = 0;
  
  // Parse timeout value
  if (timeout.endsWith('m')) {
    // Convert minutes to seconds
    timeoutSeconds = parseInt(timeout.slice(0, -1)) * 60;
  } else if (timeout.endsWith('s')) {
    // Remove 's' and use as seconds
    timeoutSeconds = parseInt(timeout.slice(0, -1));
  } else {
    // Default to seconds if no unit specified
    timeoutSeconds = parseInt(timeout);
  }
  
  // Set timeout to hide the lower third
  if (timeoutSeconds > 0) {
    setTimeout(() => {
      hideWithAnimation();
    }, timeoutSeconds * 1000);
  }
}

// Function to hide the lower third with slide out animation
function hideWithAnimation() {
  const isRightSide = position.includes('right');
  
  if (isRightSide) {
    lowerThird.style.animation = 'slideOutRight 0.8s cubic-bezier(0.4, 0, 0.2, 1) forwards';
  } else {
    lowerThird.style.animation = 'slideOutLeft 0.8s cubic-bezier(0.4, 0, 0.2, 1) forwards';
  }
}
