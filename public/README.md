# RideShare — Fixed MVP

This is the new rideshare app.

## What is fixed

The ride now follows a controlled state machine:

REQUESTED
→ ACCEPTED
→ DRIVER HEADING TO PICKUP
→ ARRIVED
→ TRIP IN PROGRESS
→ COMPLETED

The driver sees the passenger name immediately after accepting.

Example:

PICK UP COSTA
MIAMI AIRPORT

The driver gets:

- Navigate to Pickup
- I've Arrived
- Start Trip
- Navigate to Destination
- Complete Trip
- Cancel Ride

The navigation buttons open Google Maps driving directions. Browser GPS is used as the route origin when the browser allows location access.

The driver also shares GPS coordinates with the server while online and during an active ride. The rider sees the latest driver coordinates.

## Run

Open a terminal in this folder and run:

npm.cmd install
npm.cmd start

Then open:

http://localhost:3000

Rider:

http://localhost:3000/rider.html

Driver:

http://localhost:3000/driver.html

## Test

1. Open the Driver page.
2. Enter a driver name.
3. Click Go Online.
4. Open the Rider page in another tab.
5. Enter the rider name, pickup and destination.
6. Request the ride.
7. Driver receives the request.
8. Driver accepts.
9. Driver sees PICK UP <passenger name>.
10. Driver clicks Navigate to Pickup.
11. Driver clicks I've Arrived.
12. Driver clicks Start Trip.
13. Driver clicks Navigate to Destination.
14. Driver clicks Complete Trip.

The current version stores data in memory. Restarting the server clears active rides.
