TRANSPORTER7

This is the multi-user prototype requested from Transporter6.

FEATURES
- Many simultaneous drivers and passengers; tested architecture is not limited to 10.
- Real-time shared WebSocket server; no driver codes and no browser peer-to-peer discovery.
- Driver and passenger screens are different.
- Driver online/offline and available status.
- Automatic matching to currently available drivers.
- First driver to accept wins; other drivers receive ride-taken.
- Incoming driver call is a second-layer modal with a special ring and 20-second timer.
- Pickup/drop-off address suggestions through a server-side Nominatim prototype proxy.
- Driver location is shared while connected/online and after matching.
- Driver earnings and ride count screen.
- Google Maps: accepted driver -> pickup, then pickup -> destination.

RUN
1. Node.js 18+.
2. npm install
3. npm start
4. Open the deployed HTTPS address on multiple phones/computers.
5. Driver phones: DRIVER APP -> GO ONLINE.
6. Passenger phones: PASSENGER APP -> enter/select addresses -> SEND OFFER.

DEPLOYMENT
Use a Node Web Service that supports long-lived WebSockets (for example Render/Railway/Fly.io or your own server). Do not use a Vercel serverless function for the WebSocket server.

ADDRESS SEARCH
The prototype uses OpenStreetMap Nominatim. For commercial launch, use a licensed place/autocomplete provider and follow its usage limits/terms.

PRODUCTION STILL NEEDED
Real payment marketplace, persistent database, push notifications, identity/driver verification, insurance/vehicle verification, privacy/security, audit logs, cancellation/no-show policies, regulated transportation compliance, and licensed map/geocoding services.
