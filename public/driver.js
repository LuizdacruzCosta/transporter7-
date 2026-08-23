let ws = null;
let reconnectTimer = null;
let pendingMessages = [];
let lastAutoNavigatedRide = null;
let navigationWindow = null;
let online = false;
let currentRide = null;
let locationTimer = null;

const $ = id => document.getElementById(id);

function connect() {
  // Do not create duplicate WebSocket connections.
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const socket = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`
  );

  ws = socket;

  socket.onopen = () => {
    // Ignore an old socket if a newer connection replaced it.
    if (ws !== socket) return;

    register();

    // Restore any button action that was clicked while the socket
    // was reconnecting (for example after returning from Google Maps).
    if (pendingMessages.length) {
      const queued = pendingMessages.splice(0);

      for (const message of queued) {
        socket.send(JSON.stringify(message));
      }
    }

    showMessage("Connected.");
  };

  socket.onmessage = event => {
    // Ignore messages from an obsolete socket.
    if (ws !== socket) return;

    let msg;

    try {
      msg = JSON.parse(event.data);
    } catch (error) {
      console.error("Invalid WebSocket message:", error);
      return;
    }

    if (msg.type === "ride_request") {
      addRequest(msg.ride);
    }

    if (msg.type === "ride_unavailable") {
      document
        .querySelector(`[data-ride="${msg.rideId}"]`)
        ?.remove();
    }

    if (msg.type === "ride_update") {
      currentRide = msg.ride;

      if (msg.ride.driverId) {
        renderCurrentRide();

        document
          .querySelector(`[data-ride="${msg.ride.id}"]`)
          ?.remove();

        if (
          msg.ride.status === "accepted" &&
          lastAutoNavigatedRide !== msg.ride.id
        ) {
          lastAutoNavigatedRide = msg.ride.id;

          showMessage(
            `Ride accepted. PICK UP ${
              msg.ride.riderName || "Passenger"
            }.`
          );

          setTimeout(() => {
            if (
              currentRide &&
              currentRide.id === msg.ride.id &&
              currentRide.status === "accepted"
            ) {
              openNavigation(msg.ride.pickup);
            }
          }, 300);
        }
      }
    }

    if (msg.type === "driver_state") {
      online = msg.online;
      currentRide = msg.activeRide || currentRide;

      updateOnlineUI();

      if (currentRide) {
        renderCurrentRide();
      }
    }

    if (msg.type === "error") {
      showMessage(msg.message, true);
    }
  };

  socket.onclose = () => {
    // Only handle the currently active socket.
    if (ws !== socket) return;

    ws = null;

    stopLocationSharing();

    online = false;

    updateOnlineUI();

    showMessage(
      "Disconnected from server. Reconnecting...",
      true
    );

    scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose will perform the reconnect.
    showMessage(
      "WebSocket connection error. Reconnecting...",
      true
    );
  };
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;

  // Do not repeatedly create connections while the page is hidden.
  if (document.visibilityState === "hidden") return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 1000);
}

// Chrome can put this page into the Back-Forward Cache while Google Maps
// is open. When RideShare comes back, the old WebSocket may be dead.
// Reconnect immediately so the ride buttons work again.
window.addEventListener("pageshow", event => {
  if (
    event.persisted ||
    !ws ||
    ws.readyState === WebSocket.CLOSED
  ) {
    connect();
  }
});

window.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connect();
    }
  }
});

function register() {
  send({
    type: "register",
    role: "driver",
    name: $("name").value.trim() || "Driver"
  });
}

$("onlineBtn").onclick = () => {
  if (!online) {
    online = true;

    send({
      type: "driver_online",
      online: true
    });

    startLocationSharing();
  } else {
    if (
      currentRide &&
      !["completed", "cancelled"].includes(
        currentRide.status
      )
    ) {
      showMessage(
        "Finish or cancel the current ride before going offline.",
        true
      );
      return;
    }

    online = false;

    send({
      type: "driver_online",
      online: false
    });

    stopLocationSharing();
  }
};

$("name").addEventListener(
  "change",
  register
);

function addRequest(ride) {
  if (!online) {
    return;
  }

  if (
    document.querySelector(
      `[data-ride="${ride.id}"]`
    )
  ) {
    return;
  }

  const riderName =
    ride.riderName || "Passenger";

  const div =
    document.createElement("div");

  div.className = "request";

  div.dataset.ride = ride.id;

  div.innerHTML = `
    <div>
      <strong>New ride request</strong>

      <p>
        <b>Passenger:</b>
        ${escapeHtml(riderName)}
      </p>

      <p>
        <b>Pickup:</b>
        ${escapeHtml(ride.pickup)}
      </p>

      <p>
        <b>Destination:</b>
        ${escapeHtml(ride.destination)}
      </p>
    </div>

    <button>Accept Ride</button>
  `;

  div.querySelector("button").onclick = () => {
    send({
      type: "accept_ride",
      rideId: ride.id
    });

    div.remove();
  };

  const empty =
    $("requests").querySelector(".muted");

  if (empty) {
    empty.remove();
  }

  $("requests").prepend(div);
}

function renderCurrentRide() {
  if (
    !currentRide ||
    ["completed", "cancelled"].includes(
      currentRide.status
    )
  ) {
    $("currentRide").innerHTML =
      `<p class="muted">No active ride.</p>`;

    return;
  }

  const riderName =
    currentRide.riderName ||
    "Passenger";

  const flow = {
    accepted: {
      statusText: "GO TO PICKUP",
      buttonStatus: "arrived",
      buttonText: "I've Arrived"
    },

    arrived: {
      statusText: "PASSENGER READY",
      buttonStatus: "in_progress",
      buttonText: "Start Trip"
    },

    in_progress: {
      statusText: "TRIP IN PROGRESS",
      buttonStatus: "completed",
      buttonText: "Complete Trip"
    }
  };

  const step =
    flow[currentRide.status];

  if (!step) {
    return;
  }

  const showPickupNav =
    currentRide.status === "accepted";

  const showDestinationNav =
    currentRide.status === "in_progress";

  $("currentRide").innerHTML = `
    <div class="pickup-banner">

      <div class="pickup-title">
        ${
          currentRide.status === "accepted"
            ? `PICK UP ${escapeHtml(riderName)}`
            : escapeHtml(step.statusText)
        }
      </div>

      <div class="pickup-subtitle">
        ${
          currentRide.status === "accepted"
            ? escapeHtml(currentRide.pickup)
            : currentRide.status === "arrived"
              ? `Passenger: ${escapeHtml(riderName)}`
              : `Destination: ${escapeHtml(currentRide.destination)}`
        }
      </div>

      ${
        showPickupNav
          ? `
            <button
              id="navigatePickupBtn"
              class="navigate-btn"
            >
              🚗 NAVIGATE TO PICKUP
            </button>
          `
          : ""
      }

      ${
        showDestinationNav
          ? `
            <button
              id="navigateDestinationBtn"
              class="navigate-btn"
            >
              🧭 NAVIGATE TO DESTINATION
            </button>
          `
          : ""
      }

    </div>

    <div class="ride-detail">

      <div>
        <b>Passenger</b>
        <span>
          ${escapeHtml(riderName)}
        </span>
      </div>

      <div>
        <b>Pickup</b>
        <span>
          ${escapeHtml(currentRide.pickup)}
        </span>
      </div>

      <div>
        <b>Destination</b>
        <span>
          ${escapeHtml(currentRide.destination)}
        </span>
      </div>

      <div>
        <b>Ride status</b>
        <span>
          ${escapeHtml(step.statusText)}
        </span>
      </div>

    </div>

    <button id="nextBtn">
      ${escapeHtml(step.buttonText)}
    </button>

    <button
      id="cancelRideBtn"
      class="danger"
    >
      Cancel Ride
    </button>
  `;

  if (showPickupNav) {
    $("navigatePickupBtn").onclick =
      () => {
        openNavigation(
          currentRide.pickup
        );
      };
  }

  if (showDestinationNav) {
    $("navigateDestinationBtn").onclick =
      () => {
        openNavigation(
          currentRide.destination
        );
      };
  }

  $("nextBtn").onclick = () => {
    send({
      type: "update_ride",
      rideId: currentRide.id,
      status: step.buttonStatus
    });
  };

  $("cancelRideBtn").onclick = () => {
    send({
      type: "cancel_ride",
      rideId: currentRide.id
    });

    lastAutoNavigatedRide = null;
    navigationWindow = null;
  };
}

function openNavigation(destination) {
  if (!destination) {
    showMessage(
      "No navigation destination is available.",
      true
    );

    return;
  }

  const encodedDestination =
    encodeURIComponent(destination);

  const navigationUrl =
    `https://www.google.com/maps/dir/?api=1` +
    `&destination=${encodedDestination}` +
    `&travelmode=driving` +
    `&dir_action=navigate`;

  // Keep RideShare open. Google Maps opens in another tab/window.
  const navigationTab = window.open(
    navigationUrl,
    "_blank",
    "noopener,noreferrer"
  );

  if (!navigationTab) {
    showMessage(
      "Google Maps was blocked. Please allow pop-ups for this site.",
      true
    );
  }
}

function startLocationSharing() {
  stopLocationSharing();

  if (!navigator.geolocation) {
    showMessage(
      "Geolocation is not supported by this browser.",
      true
    );

    return;
  }

  const sendPosition =
    position => {
      send({
        type: "driver_location",
        latitude:
          position.coords.latitude,
        longitude:
          position.coords.longitude
      });
    };

  navigator.geolocation.getCurrentPosition(
    sendPosition,
    error => {
      console.log(
        "Initial location error:",
        error
      );
    },
    {
      enableHighAccuracy: true,
      timeout: 8000,
      maximumAge: 5000
    }
  );

  locationTimer =
    navigator.geolocation.watchPosition(
      sendPosition,
      error => {
        console.log(
          "Location watch error:",
          error
        );
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 5000
      }
    );
}

function stopLocationSharing() {
  if (
    locationTimer !== null &&
    navigator.geolocation
  ) {
    navigator.geolocation.clearWatch(
      locationTimer
    );
  }

  locationTimer = null;
}

function updateOnlineUI() {
  $("onlineLabel").textContent =
    online
      ? "Online — accepting rides"
      : "Offline";

  $("onlineLabel").className =
    online ? "online" : "";

  $("onlineBtn").textContent =
    online
      ? "Go Offline"
      : "Go Online";

  $("onlineBtn").className =
    online ? "secondary" : "";

  if (online) {
    $("requests").innerHTML =
      $("requests").querySelector(
        ".request"
      )
        ? $("requests").innerHTML
        : `<p class="muted">Waiting for ride requests...</p>`;
  } else {
    $("requests").innerHTML =
      `<p class="muted">Go online to receive ride requests.</p>`;
  }
}

function send(message) {
  if (
    ws &&
    ws.readyState === WebSocket.OPEN
  ) {
    ws.send(JSON.stringify(message));
    return true;
  }

  // Do not lose a button click just because the browser is reconnecting.
  pendingMessages.push(message);

  showMessage(
    "Reconnecting to server...",
    true
  );

  connect();
  return false;
}

function showMessage(
  text,
  error = false
) {
  const message =
    $("message");

  if (!message) {
    return;
  }

  message.textContent = text;

  message.className =
    `message ${error ? "error" : ""}`;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    c => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[c])
  );
}

connect();
