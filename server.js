const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static("public"));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "RideShare",
    version: "2.0.0",
    time: new Date().toISOString()
  });
});

const clients = new Map();
const drivers = new Map();
const rides = new Map();

const TERMINAL_STATUSES = new Set(["completed", "cancelled"]);

function now() {
  return new Date().toISOString();
}

function send(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function sendTo(clientId, message) {
  const client = clients.get(clientId);
  if (client) send(client.ws, message);
}

function broadcast(message, predicate = () => true) {
  for (const client of clients.values()) {
    if (predicate(client)) send(client.ws, message);
  }
}

function safeText(value, max = 200) {
  return String(value ?? "").trim().slice(0, max);
}

function activeRideForRider(riderId) {
  return [...rides.values()].find(
    ride =>
      ride.riderId === riderId &&
      !TERMINAL_STATUSES.has(ride.status)
  );
}

function activeRideForDriver(driverId) {
  return [...rides.values()].find(
    ride =>
      ride.driverId === driverId &&
      !TERMINAL_STATUSES.has(ride.status)
  );
}

function availableDrivers() {
  return [...drivers.values()].filter(
    driver => driver.online && !driver.rideId
  );
}

function publicRide(ride) {
  return {
    id: ride.id,
    riderId: ride.riderId,
    riderName: ride.riderName,
    driverId: ride.driverId,
    driverName: ride.driverName,
    pickup: ride.pickup,
    destination: ride.destination,
    status: ride.status,
    createdAt: ride.createdAt,
    acceptedAt: ride.acceptedAt,
    arrivedAt: ride.arrivedAt,
    startedAt: ride.startedAt,
    completedAt: ride.completedAt,
    cancelledAt: ride.cancelledAt,
    driverLocation: ride.driverLocation
  };
}

function makeRide(rider, pickup, destination) {
  return {
    id: crypto.randomUUID(),

    riderId: rider.id,
    riderName: rider.name,

    driverId: null,
    driverName: null,

    pickup,
    destination,

    status: "requested",

    createdAt: now(),
    acceptedAt: null,
    arrivedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,

    driverLocation: null
  };
}

function notifyRide(ride) {
  sendTo(ride.riderId, {
    type: "ride_update",
    ride: publicRide(ride)
  });

  if (ride.driverId) {
    sendTo(ride.driverId, {
      type: "ride_update",
      ride: publicRide(ride)
    });
  }
}

function notifyAvailableDrivers(ride) {
  for (const driver of availableDrivers()) {
    sendTo(driver.clientId, {
      type: "ride_request",
      ride: publicRide(ride)
    });
  }
}

function sendDriverSnapshot(clientId) {
  const driver = drivers.get(clientId);

  if (!driver) return;

  const activeRide =
    driver.rideId
      ? rides.get(driver.rideId)
      : null;

  sendTo(clientId, {
    type: "driver_state",

    online: driver.online,

    rideId: driver.rideId,

    activeRide:
      activeRide
        ? publicRide(activeRide)
        : null
  });
}

function sendRiderSnapshot(clientId) {
  const activeRide =
    activeRideForRider(clientId);

  sendTo(clientId, {
    type: "rider_state",

    activeRide:
      activeRide
        ? publicRide(activeRide)
        : null,

    driversAvailable:
      availableDrivers().length
  });
}

wss.on("connection", ws => {

  const clientId =
    crypto.randomUUID();

  clients.set(clientId, {
    id: clientId,
    ws,
    role: null,
    name: "Guest"
  });

  send(ws, {
    type: "connected",
    clientId
  });

  ws.on("message", raw => {

    let msg;

    try {
      msg = JSON.parse(
        raw.toString()
      );
    } catch {
      return send(ws, {
        type: "error",
        message: "Invalid message."
      });
    }

    const client =
      clients.get(clientId);

    if (!client) return;

    switch (msg.type) {

      // =================================
      // REGISTER
      // =================================

      case "register": {

        const role =
          msg.role === "driver"
            ? "driver"
            : "rider";

        const name =
          safeText(msg.name, 80) ||
          (
            role === "driver"
              ? "Driver"
              : "Rider"
          );

        if (
          client.role === "driver" &&
          role !== "driver"
        ) {
          drivers.delete(clientId);
        }

        client.role = role;
        client.name = name;

        if (role === "driver") {

          const existing =
            drivers.get(clientId);

          drivers.set(clientId, {

            clientId,

            name,

            online:
              existing?.online ?? false,

            rideId:
              existing?.rideId ?? null,

            location:
              existing?.location ?? null

          });

          sendDriverSnapshot(
            clientId
          );

        } else {

          sendRiderSnapshot(
            clientId
          );
        }

        send(ws, {
          type: "registered",
          clientId,
          role,
          name
        });

        break;
      }


      // =================================
      // DRIVER ONLINE / OFFLINE
      // =================================

      case "driver_online": {

        const driver =
          drivers.get(clientId);

        if (!driver) {

          return send(ws, {
            type: "error",
            message:
              "Register as a driver first."
          });

        }

        if (
          driver.rideId &&
          msg.online === false
        ) {

          return send(ws, {
            type: "error",
            message:
              "Finish or cancel the current ride before going offline."
          });

        }

        driver.online =
          Boolean(msg.online);

        sendDriverSnapshot(
          clientId
        );

        if (driver.online) {

          for (
            const ride of rides.values()
          ) {

            if (
              ride.status === "requested" &&
              !ride.driverId
            ) {

              send(ws, {
                type: "ride_request",
                ride: publicRide(ride)
              });

            }

          }

        }

        break;
      }


      // =================================
      // REQUEST RIDE
      // =================================

      case "request_ride": {

        if (
          client.role !== "rider"
        ) {

          return send(ws, {
            type: "error",
            message:
              "Only riders can request rides."
          });

        }

        const pickup =
          safeText(msg.pickup);

        const destination =
          safeText(msg.destination);

        if (
          !pickup ||
          !destination
        ) {

          return send(ws, {
            type: "error",
            message:
              "Enter both pickup and destination."
          });

        }

        if (
          activeRideForRider(clientId)
        ) {

          return send(ws, {
            type: "error",
            message:
              "You already have an active ride."
          });

        }

        const ride =
          makeRide(
            client,
            pickup,
            destination
          );

        rides.set(
          ride.id,
          ride
        );

        send(ws, {
          type: "ride_created",

          ride:
            publicRide(ride),

          driversAvailable:
            availableDrivers().length
        });

        notifyAvailableDrivers(
          ride
        );

        break;
      }


      // =================================
      // ACCEPT RIDE
      // =================================

      case "accept_ride": {

        const driver =
          drivers.get(clientId);

        const ride =
          rides.get(msg.rideId);

        if (
          !driver ||
          !ride
        ) {

          return send(ws, {
            type: "error",
            message:
              "Ride not found."
          });

        }

        if (
          !driver.online ||
          driver.rideId
        ) {

          return send(ws, {
            type: "error",
            message:
              "You are not available for this ride."
          });

        }

        if (
          ride.status !== "requested" ||
          ride.driverId
        ) {

          return send(ws, {
            type: "error",
            message:
              "This ride was already accepted by another driver."
          });

        }

        ride.driverId =
          clientId;

        ride.driverName =
          driver.name;

        ride.status =
          "accepted";

        ride.acceptedAt =
          now();

        driver.rideId =
          ride.id;

        notifyRide(
          ride
        );

        // Remove this ride from
        // every other driver's list.

        broadcast(
          {
            type:
              "ride_unavailable",

            rideId:
              ride.id
          },

          c =>
            c.role === "driver" &&
            c.id !== clientId
        );

        sendDriverSnapshot(
          clientId
        );

        break;
      }


      // =================================
      // DRIVER RIDE STATE
      //
      // accepted
      //     ↓
      // arrived
      //     ↓
      // in_progress
      //     ↓
      // completed
      // =================================

      case "update_ride": {

        const ride =
          rides.get(msg.rideId);

        if (!ride) {

          return send(ws, {
            type: "error",
            message:
              "Ride not found."
          });

        }

        if (
          ride.driverId !== clientId
        ) {

          return send(ws, {
            type: "error",
            message:
              "Only the assigned driver can update this ride."
          });

        }

        const transitions = {

          accepted:
            "arrived",

          arrived:
            "in_progress",

          in_progress:
            "completed"

        };

        const nextStatus =
          safeText(
            msg.status,
            30
          );

        if (
          transitions[ride.status] !==
          nextStatus
        ) {

          return send(ws, {
            type: "error",

            message:
              `Invalid ride transition: ${ride.status} → ${nextStatus}.`
          });

        }

        // ---------------------------------
        // CHANGE RIDE STATUS
        // ---------------------------------

        ride.status =
          nextStatus;

        if (
          nextStatus === "arrived"
        ) {

          ride.arrivedAt =
            now();

        }

        if (
          nextStatus === "in_progress"
        ) {

          ride.startedAt =
            now();

        }

        if (
          nextStatus === "completed"
        ) {

          ride.completedAt =
            now();

        }

        // ---------------------------------
        // COMPLETED
        // ---------------------------------

        if (
          nextStatus === "completed"
        ) {

          const driver =
            drivers.get(
              clientId
            );

          if (driver) {

            driver.rideId =
              null;

            driver.online =
              true;

          }

        }

        // ---------------------------------
        // SEND NEW RIDE STATE
        // TO RIDER + DRIVER
        // ---------------------------------

        notifyRide(
          ride
        );

        // ---------------------------------
        // REFRESH DRIVER DASHBOARD
        // AFTER EVERY BUTTON
        // ---------------------------------

        sendDriverSnapshot(
          clientId
        );

        break;
      }


      // =================================
      // DRIVER LOCATION
      // =================================

      case "driver_location": {

        const driver =
          drivers.get(clientId);

        if (!driver) return;

        const latitude =
          Number(
            msg.latitude
          );

        const longitude =
          Number(
            msg.longitude
          );

        if (
          !Number.isFinite(latitude) ||
          !Number.isFinite(longitude)
        ) {
          return;
        }

        if (
          latitude < -90 ||
          latitude > 90 ||
          longitude < -180 ||
          longitude > 180
        ) {
          return;
        }

        driver.location = {

          latitude,

          longitude,

          updatedAt:
            now()

        };

        if (
          driver.rideId
        ) {

          const ride =
            rides.get(
              driver.rideId
            );

          if (
            ride &&
            !TERMINAL_STATUSES.has(
              ride.status
            )
          ) {

            ride.driverLocation =
              driver.location;

            sendTo(
              ride.riderId,
              {
                type:
                  "driver_location",

                rideId:
                  ride.id,

                location:
                  ride.driverLocation
              }
            );

          }

        }

        break;
      }


      // =================================
      // CANCEL RIDE
      // =================================

      case "cancel_ride": {

        const ride =
          rides.get(msg.rideId);

        if (!ride) {

          return send(ws, {
            type: "error",
            message:
              "Ride not found."
          });

        }

        if (
          clientId !== ride.riderId &&
          clientId !== ride.driverId
        ) {

          return send(ws, {
            type: "error",
            message:
              "You are not part of this ride."
          });

        }

        if (
          TERMINAL_STATUSES.has(
            ride.status
          )
        ) {

          return send(ws, {
            type: "error",
            message:
              "Ride is already closed."
          });

        }

        ride.status =
          "cancelled";

        ride.cancelledAt =
          now();

        if (
          ride.driverId
        ) {

          const driver =
            drivers.get(
              ride.driverId
            );

          if (driver) {

            driver.rideId =
              null;

            driver.online =
              true;

          }

        }

        notifyRide(
          ride
        );

        if (
          ride.driverId
        ) {

          sendDriverSnapshot(
            ride.driverId
          );

        }

        break;
      }


      // =================================
      // GET CURRENT STATE
      // =================================

      case "get_state": {

        if (
          client.role === "driver"
        ) {

          sendDriverSnapshot(
            clientId
          );

        }

        if (
          client.role === "rider"
        ) {

          sendRiderSnapshot(
            clientId
          );

        }

        break;
      }


      // =================================
      // UNKNOWN MESSAGE
      // =================================

      default: {

        send(ws, {
          type: "error",
          message:
            "Unknown command."
        });

        break;
      }

    }

  });


  // =================================
  // DISCONNECT
  // =================================

  ws.on("close", () => {

    const driver =
      drivers.get(clientId);

    if (driver) {

      if (driver.rideId) {

        const ride =
          rides.get(
            driver.rideId
          );

        if (
          ride &&
          !TERMINAL_STATUSES.has(
            ride.status
          )
        ) {

          ride.status =
            "cancelled";

          ride.cancelledAt =
            now();

          sendTo(
            ride.riderId,
            {
              type:
                "ride_update",

              ride:
                publicRide(ride)
            }
          );

        }

      }

      drivers.delete(
        clientId
      );

    }

    clients.delete(
      clientId
    );

  });

});


// =================================
// START SERVER
// =================================

const PORT =
  process.env.PORT || 3000;

server.listen(
  PORT,
  () => {

    console.log(
      `RideShare running at http://localhost:${PORT}`
    );

  }
);
