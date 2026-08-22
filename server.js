const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static('public'));

app.get('/health', (_, res) =>
  res.json({ ok: true, service: 'Transporter7' })
);

app.get('/api/address', async (req, res) => {
  const q = String(req.query.q || '').trim();

  if (q.length < 3) return res.json([]);

  try {
    const x = await fetch(
      'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=' +
        encodeURIComponent(q),
      {
        headers: {
          'User-Agent': 'Transporter7-prototype/1.0'
        }
      }
    );

    res.json(
      x.ok
        ? (await x.json()).map(a => ({
            display_name: a.display_name,
            lat: a.lat,
            lon: a.lon
          }))
        : []
    );
  } catch (e) {
    res.json([]);
  }
});

const users = new Map();
const rides = new Map();

let seq = 1000;

const OFFER_SECONDS = 20;

const send = (ws, message) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
};

const drivers = () =>
  [...users.values()].filter(
    u =>
      u.role === 'driver' &&
      u.online &&
      u.available &&
      u.ws.readyState === WebSocket.OPEN
  );

const count = () => {
  const n = drivers().length;

  for (const u of users.values()) {
    if (u.role === 'passenger') {
      send(u.ws, {
        type: 'driver_count',
        count: n
      });
    }
  }
};

const dist = (a, b) => {
  if (!a || !b || a.lat == null || b.lat == null) {
    return 999999;
  }

  const p = Math.PI / 180;
  const R = 6371;

  const d1 = (b.lat - a.lat) * p;
  const d2 = (b.lng - a.lng) * p;

  const x =
    Math.sin(d1 / 2) ** 2 +
    Math.cos(a.lat * p) *
      Math.cos(b.lat * p) *
      Math.sin(d2 / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(x));
};

function finishSearch(r, messageType = 'no_driver') {
  if (!r) return;

  clearTimeout(r.offerTimer);
  r.offerTimer = null;
  r.currentDriverId = null;
  r.status = 'no_driver';

  const p = users.get(r.passengerId);

  if (p) {
    p.rideId = null;
  }

  send(p?.ws, {
    type: messageType,
    rideId: r.id
  });
}

function offerNextDriver(r) {
  if (!r || r.status !== 'searching') return;

  clearTimeout(r.offerTimer);
  r.offerTimer = null;

  while (
    r.candidates.length &&
    (
      !users.get(r.candidates[0]) ||
      !users.get(r.candidates[0]).online ||
      !users.get(r.candidates[0]).available ||
      users.get(r.candidates[0]).ws.readyState !== WebSocket.OPEN
    )
  ) {
    r.candidates.shift();
  }

  if (!r.candidates.length) {
    finishSearch(r);
    return;
  }

  const driverId = r.candidates.shift();
  const d = users.get(driverId);

  if (!d) {
    offerNextDriver(r);
    return;
  }

  r.currentDriverId = driverId;
  r.offerStartedAt = Date.now();

  send(d.ws, {
    type: 'ride_call',
    ride: r,
    callSeconds: OFFER_SECONDS,
    nearbyKm: dist(d, r.pickupCoords)
  });

  r.offerTimer = setTimeout(() => {
    const current = rides.get(r.id);

    if (
      !current ||
      current.status !== 'searching' ||
      current.currentDriverId !== driverId
    ) {
      return;
    }

    send(d.ws, {
      type: 'ride_timeout',
      rideId: r.id
    });

    current.currentDriverId = null;

    offerNextDriver(current);
  }, OFFER_SECONDS * 1000);
}

wss.on('connection', ws => {
  let uid = null;

  ws.on('message', raw => {
    let m;

    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }

    if (m.type === 'hello') {
      uid =
        'u' +
        ++seq +
        '_' +
        Math.random().toString(36).slice(2, 7);

      users.set(uid, {
        id: uid,
        ws,
        role: m.role,
        name: String(m.name || 'User'),
        online: true,
        available: m.role === 'driver',
        lat: null,
        lng: null,
        rideId: null
      });

      send(ws, {
        type: 'hello_ok',
        userId: uid
      });

      count();
      return;
    }

    const u = users.get(uid);

    if (!u) return;

    if (m.type === 'profile') {
      if (m.name) {
        u.name = String(m.name).slice(0, 80);
      }

      return;
    }

    if (m.type === 'driver_status' && u.role === 'driver') {
      u.online = !!m.online;
      u.available = !!m.online && !u.rideId;

      if (!u.online) {
        for (const r of rides.values()) {
          if (
            r.status === 'searching' &&
            r.currentDriverId === uid
          ) {
            clearTimeout(r.offerTimer);
            r.offerTimer = null;
            r.currentDriverId = null;

            offerNextDriver(r);
          }
        }
      }

      count();
      return;
    }

    if (m.type === 'location') {
      u.lat = +m.lat;
      u.lng = +m.lng;

      if (u.rideId) {
        const r = rides.get(u.rideId);

        if (r) {
          for (const x of users.values()) {
            if (x.rideId === u.rideId) {
              send(x.ws, {
                type: 'location',
                role: u.role,
                lat: u.lat,
                lng: u.lng,
                rideId: u.rideId
              });
            }
          }
        }
      }

      return;
    }

    if (
      m.type === 'passenger_offer' &&
      u.role === 'passenger'
    ) {
      const r = {
        id: 'R' + ++seq,
        passengerId: uid,
        passengerName: u.name,
        pickup: m.ride.pickup,
        destination: m.ride.destination,
        pax: +m.ride.pax || 1,
        fare: +m.ride.fare || 0,
        pickupCoords: m.ride.pickupCoords || null,
        status: 'searching',
        createdAt: Date.now(),
        candidates: [],
        currentDriverId: null,
        offerTimer: null
      };

      rides.set(r.id, r);
      u.rideId = r.id;

      r.candidates = drivers()
        .sort(
          (a, b) =>
            dist(a, r.pickupCoords) -
            dist(b, r.pickupCoords)
        )
        .map(d => d.id);

      if (!r.candidates.length) {
        finishSearch(r);
        return;
      }

      offerNextDriver(r);

      send(ws, {
        type: 'searching',
        rideId: r.id,
        driverCount: r.candidates.length + 1
      });

      return;
    }

    /*
     * DRIVER PASSES THE RIDE
     *
     * The current driver loses the offer.
     * The offer immediately moves to the next driver.
     */
    if (
      m.type === 'driver_pass' ||
      m.type === 'driver_timeout'
    ) {
      const r = rides.get(m.rideId);

      if (
        !r ||
        r.status !== 'searching' ||
        r.currentDriverId !== uid
      ) {
        return;
      }

      clearTimeout(r.offerTimer);
      r.offerTimer = null;
      r.currentDriverId = null;

      send(ws, {
        type: 'offer_passed',
        rideId: r.id
      });

      offerNextDriver(r);
      return;
    }

    /*
     * DRIVER ACCEPTS THE RIDE
     *
     * The server verifies that THIS driver is
     * the driver currently receiving the offer.
     */
    if (m.type === 'driver_accept') {
      const r = rides.get(m.rideId);
      const d = u;

      if (
        !r ||
        r.status !== 'searching' ||
        r.currentDriverId !== uid ||
        d.role !== 'driver' ||
        !d.online ||
        !d.available
      ) {
        send(ws, {
          type: 'ride_lost',
          rideId: m.rideId
        });

        return;
      }

      clearTimeout(r.offerTimer);
      r.offerTimer = null;

      r.status = 'accepted';
      r.driverId = uid;
      r.driverName = d.name;
      r.currentDriverId = null;

      d.available = false;
      d.rideId = r.id;

      const p = users.get(r.passengerId);

      /*
       * Tell passenger that a driver accepted.
       */
      send(p?.ws, {
        type: 'matched',
        ride: r,
        driver: {
          id: uid,
          name: d.name,
          lat: d.lat,
          lng: d.lng
        }
      });

      /*
       * Tell accepting driver.
       */
      send(ws, {
        type: 'accepted',
        ride: r
      });

      /*
       * Tell all other drivers that this ride
       * has already been taken.
       */
      for (const x of users.values()) {
        if (
          x.role === 'driver' &&
          x.id !== uid
        ) {
          send(x.ws, {
            type: 'ride_taken',
            rideId: r.id
          });
        }
      }

      count();
      return;
    }

    if (m.type === 'ride_state') {
      const r = rides.get(m.rideId);

      if (!r) return;

      r.status = m.state;

      const p = users.get(r.passengerId);
      const d = users.get(r.driverId);

      send(p?.ws, {
        type: 'ride_state',
        state: r.status,
        ride: r
      });

      send(d?.ws, {
        type: 'ride_state',
        state: r.status,
        ride: r
      });

      if (m.state === 'completed') {
        if (p) {
          p.rideId = null;
        }

        if (d) {
          d.rideId = null;
          d.available = d.online;
        }

        count();
      }

      return;
    }

    if (m.type === 'cancel_ride') {
      const r = rides.get(m.rideId);

      if (!r) return;

      clearTimeout(r.offerTimer);

      r.offerTimer = null;
      r.status = 'cancelled';
      r.currentDriverId = null;

      const p = users.get(r.passengerId);
      const d = users.get(r.driverId);

      if (p) {
        p.rideId = null;
      }

      if (d) {
        d.rideId = null;
        d.available = d.online;
      }

      send(p?.ws, {
        type: 'cancelled',
        ride: r
      });

      send(d?.ws, {
        type: 'cancelled',
        ride: r
      });

      for (const x of users.values()) {
        if (x.role === 'driver') {
          send(x.ws, {
            type: 'ride_cancelled',
            rideId: r.id
          });
        }
      }

      count();
      return;
    }
  });

  ws.on('close', () => {
    if (!uid) return;

    const u = users.get(uid);

    if (u?.rideId) {
      const r = rides.get(u.rideId);

      if (
        r &&
        r.status === 'searching' &&
        r.passengerId === uid
      ) {
        clearTimeout(r.offerTimer);

        r.status = 'cancelled';
        r.currentDriverId = null;

        for (const x of users.values()) {
          if (x.role === 'driver') {
            send(x.ws, {
              type: 'ride_cancelled',
              rideId: r.id
            });
          }
        }
      }
    }

    /*
     * If the driver receiving an offer disconnects,
     * automatically move the offer to the next driver.
     */
    for (const r of rides.values()) {
      if (
        r.status === 'searching' &&
        r.currentDriverId === uid
      ) {
        clearTimeout(r.offerTimer);

        r.offerTimer = null;
        r.currentDriverId = null;

        offerNextDriver(r);
      }
    }

    users.delete(uid);
    count();
  });
});

server.listen(
  process.env.PORT || 3000,
  () => console.log('Transporter7 ready')
);
