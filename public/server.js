const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static('public'));

app.get('/health', (_, res) =>
  res.json({
    ok: true,
    service: 'Transporter7'
  })
);

app.get('/api/address', async (req, res) => {

  const q = String(req.query.q || '').trim();

  if (q.length < 3) {
    return res.json([]);
  }

  try {

    const x = await fetch(
      'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=' +
      encodeURIComponent(q),
      {
        headers:{
          'User-Agent':'Transporter7/2.0'
        }
      }
    );

    if (!x.ok) {
      return res.json([]);
    }

    const data = await x.json();

    res.json(
      data.map(a => ({
        display_name:a.display_name,
        lat:a.lat,
        lon:a.lon
      }))
    );

  } catch(e){

    res.json([]);

  }

});


// ===============================
// STORAGE
// ===============================

const users = new Map();
const rides = new Map();

let seq = 1000;

const OFFER_SECONDS = 20;


// ===============================
// SEND
// ===============================

function send(ws,message){

  if(
    ws &&
    ws.readyState === WebSocket.OPEN
  ){
    ws.send(
      JSON.stringify(message)
    );
  }

}


// ===============================
// DRIVERS
// ===============================

function drivers(){

  return [
    ...users.values()
  ].filter(
    u =>
      u.role === 'driver' &&
      u.online &&
      u.available &&
      u.ws.readyState === WebSocket.OPEN
  );

}


function count(){

  const n = drivers().length;

  for(const u of users.values()){

    if(u.role === 'passenger'){

      send(
        u.ws,
        {
          type:'driver_count',
          count:n
        }
      );

    }

  }

}


// ===============================
// DISTANCE
// ===============================

function dist(a,b){

  if(
    !a ||
    !b ||
    a.lat == null ||
    a.lng == null ||
    b.lat == null ||
    b.lng == null
  ){
    return 999999;
  }


  const p = Math.PI / 180;
  const R = 6371;


  const dLat =
    (b.lat-a.lat)*p;


  const dLng =
    (b.lng-a.lng)*p;


  const x =
    Math.sin(dLat/2)**2 +
    Math.cos(a.lat*p) *
    Math.cos(b.lat*p) *
    Math.sin(dLng/2)**2;


  return (
    2 *
    R *
    Math.asin(
      Math.sqrt(x)
    )
  );

}


// ===============================
// FINISH SEARCH
// ===============================

function finishSearch(
  r,
  messageType='no_driver'
){

  if(!r) return;


  clearTimeout(
    r.offerTimer
  );


  r.offerTimer=null;

  r.currentDrivers=[];

  r.status='no_driver';


  const p =
    users.get(
      r.passengerId
    );


  if(p){
    p.rideId=null;
  }


  send(
    p?.ws,
    {
      type:messageType,
      rideId:r.id
    }
  );

}


// ===============================
// MULTI DRIVER OFFER
// ===============================

function offerDrivers(r){

  if(
    !r ||
    r.status !== 'searching'
  ){
    return;
  }


  clearTimeout(
    r.offerTimer
  );


  const available =
    r.candidates
    .map(id=>users.get(id))
    .filter(
      d =>
        d &&
        d.online &&
        d.available &&
        d.ws.readyState === WebSocket.OPEN
    );


  if(!available.length){

    return finishSearch(r);

  }


  r.currentDrivers =
    available.map(
      d=>d.id
    );


  for(const d of available){

    send(
      d.ws,
      {
        type:'ride_call',
        ride:r,
        callSeconds:OFFER_SECONDS,
        nearbyKm:dist(
          d,
          r.pickupCoords
        )
      }
    );

  }


  r.offerTimer =
    setTimeout(
      ()=>{

        const current =
          rides.get(r.id);


        if(
          !current ||
          current.status !== 'searching'
        ){
          return;
        }


        for(
          const id of current.currentDrivers
        ){

          const d =
            users.get(id);


          send(
            d?.ws,
            {
              type:'ride_timeout',
              rideId:r.id
            }
          );

        }


        finishSearch(current);

      },
      OFFER_SECONDS * 1000
    );

}
// ===============================
// WEBSOCKET
// ===============================

wss.on('connection', ws => {

  let uid = null;


  ws.on('message', raw => {

    let m;

    try {
      m = JSON.parse(raw);
    }
    catch(e){
      return;
    }



    // ===============================
    // HELLO
    // ===============================

    if(m.type === 'hello'){

      uid =
        'u' +
        ++seq +
        '_' +
        Math.random()
        .toString(36)
        .slice(2,7);


      users.set(uid,{

        id:uid,

        ws,

        role:m.role,

        name:String(
          m.name || 'User'
        ),

        online:true,

        available:
          m.role === 'driver',

        lat:null,

        lng:null,

        rideId:null

      });


      send(
        ws,
        {
          type:'hello_ok',
          userId:uid
        }
      );


      count();

      return;

    }



    const u =
      users.get(uid);


    if(!u){
      return;
    }



    // ===============================
    // PROFILE
    // ===============================

    if(m.type === 'profile'){

      if(m.name){

        u.name =
          String(m.name)
          .slice(0,80);

      }

      return;

    }



    // ===============================
    // DRIVER STATUS
    // ===============================

    if(
      m.type === 'driver_status' &&
      u.role === 'driver'
    ){

      u.online =
        !!m.online;


      u.available =
        !!m.online &&
        !u.rideId;



      if(!u.online){

        for(const r of rides.values()){

          if(
            r.status === 'searching' &&
            r.currentDrivers &&
            r.currentDrivers.includes(uid)
          ){

            r.currentDrivers =
              r.currentDrivers
              .filter(
                id=>id!==uid
              );

          }

        }

      }


      count();

      return;

    }




    // ===============================
    // LOCATION
    // ===============================

    if(m.type === 'location'){

      u.lat =
        Number(m.lat);


      u.lng =
        Number(m.lng);



      if(u.rideId){

        const r =
          rides.get(
            u.rideId
          );


        if(r){

          for(const x of users.values()){

            if(
              x.rideId ===
              u.rideId
            ){

              send(
                x.ws,
                {
                  type:'location',
                  role:u.role,
                  lat:u.lat,
                  lng:u.lng,
                  rideId:u.rideId
                }
              );

            }

          }

        }

      }


      return;

    }





    // ===============================
    // PASSENGER REQUEST
    // ===============================

    if(
      m.type === 'passenger_offer' &&
      u.role === 'passenger'
    ){


      if(u.rideId){

        return send(
          ws,
          {
            type:'error',
            message:
              'Passenger already has an active ride.'
          }
        );

      }



      const r = {

        id:
          'R' + ++seq,


        passengerId:
          uid,


        passengerName:
          u.name,


        pickup:
          m.ride.pickup,


        destination:
          m.ride.destination,


        pax:
          Number(m.ride.pax) || 1,


        fare:
          Number(m.ride.fare) || 0,


        pickupCoords:
          m.ride.pickupCoords || null,


        destinationCoords:
          m.ride.destinationCoords || null,


        status:
          'searching',


        createdAt:
          Date.now(),


        candidates:[],


        currentDrivers:[],


        driverId:null,


        offerTimer:null

      };



      rides.set(
        r.id,
        r
      );


      u.rideId =
        r.id;



      r.candidates =
        drivers()
        .sort(
          (a,b)=>
            dist(
              a,
              r.pickupCoords
            )
            -
            dist(
              b,
              r.pickupCoords
            )
        )
        .map(
          d=>d.id
        );



      if(!r.candidates.length){

        return finishSearch(r);

      }



      offerDrivers(r);



      send(
        ws,
        {
          type:'searching',
          rideId:r.id,
          driverCount:
            r.candidates.length
        }
      );


      return;

    }






    // ===============================
    // DRIVER PASS / TIMEOUT
    // ===============================

    if(
      m.type === 'driver_pass' ||
      m.type === 'driver_timeout'
    ){

      const r =
        rides.get(
          m.rideId
        );


      if(
        !r ||
        r.status !== 'searching' ||
        !r.currentDrivers.includes(uid)
      ){

        return;

      }



      r.currentDrivers =
        r.currentDrivers
        .filter(
          id=>id!==uid
        );



      send(
        ws,
        {
          type:'offer_passed',
          rideId:r.id
        }
      );



      if(
        !r.currentDrivers.length
      ){

        offerDrivers(r);

      }


      return;

    }





    // ===============================
    // DRIVER ACCEPT
    // ===============================

    if(m.type === 'driver_accept'){


      const r =
        rides.get(
          m.rideId
        );


      if(
        !r ||
        r.status !== 'searching' ||
        !r.currentDrivers.includes(uid) ||
        u.role !== 'driver' ||
        !u.online ||
        !u.available
      ){

        return send(
          ws,
          {
            type:'ride_lost',
            rideId:m.rideId
          }
        );

      }




      clearTimeout(
        r.offerTimer
      );


      r.offerTimer =
        null;



      // FIRST DRIVER WINS

      r.status =
        'accepted';


      r.driverId =
        uid;


      r.driverName =
        u.name;


      r.currentDrivers =
        [];



      u.available =
        false;


      u.rideId =
        r.id;



      const p =
        users.get(
          r.passengerId
        );



      send(
        p?.ws,
        {
          type:'matched',
          ride:r,
          driver:{
            id:uid,
            name:u.name,
            lat:u.lat,
            lng:u.lng
          }
        }
      );



      send(
        ws,
        {
          type:'accepted',
          ride:r
        }
      );



      // notify losing drivers

      for(const d of users.values()){

        if(
          d.role === 'driver' &&
          d.id !== uid
        ){

          send(
            d.ws,
            {
              type:'ride_taken',
              rideId:r.id
            }
          );

        }

      }



      count();

      return;

    }
// ===============================
// RIDE STATE MACHINE
// ===============================

const validTransitions = {

  accepted:[
    'going_to_pickup',
    'cancelled'
  ],

  going_to_pickup:[
    'arrived',
    'cancelled'
  ],

  arrived:[
    'started',
    'cancelled'
  ],

  started:[
    'completed',
    'cancelled'
  ]

};



function notifyRideState(
  r,
  state,
  message
){

  r.status =
    state;


  r.updatedAt =
    Date.now();



  const p =
    users.get(
      r.passengerId
    );


  const d =
    users.get(
      r.driverId
    );



  const payload = {

    type:'ride_state',

    state,

    ride:r,

    message:
      message || null

  };



  send(
    p?.ws,
    payload
  );


  send(
    d?.ws,
    payload
  );

}




// ===============================
// RIDE STATE MESSAGE
// ===============================

if(m.type === 'ride_state'){

  const r =
    rides.get(
      m.rideId
    );



  if(
    !r ||
    r.driverId !== uid
  ){

    return;

  }



  const next =
    String(
      m.state || ''
    );



  if(
    !validTransitions[
      r.status
    ]?.includes(next)
  ){

    return send(
      ws,
      {
        type:'state_rejected',
        rideId:r.id,
        state:next,
        currentState:r.status
      }
    );

  }



  const messages = {

    going_to_pickup:
      `Driver ${r.driverName} is going to pickup.`,

    arrived:
      `Driver ${r.driverName} arrived.`,

    started:
      `Ride started.`,

    completed:
      `Ride completed. Thank you.`,

    cancelled:
      `Ride cancelled.`

  };



  notifyRideState(
    r,
    next,
    messages[next]
  );



  if(
    next === 'completed' ||
    next === 'cancelled'
  ){

    const p =
      users.get(
        r.passengerId
      );


    const d =
      users.get(
        r.driverId
      );



    if(p){

      p.rideId =
        null;

    }


    if(d){

      d.rideId =
        null;


      d.available =
        d.online;

    }


    count();

  }



  return;

}





// ===============================
// CANCEL RIDE
// ===============================

if(m.type === 'cancel_ride'){


  const r =
    rides.get(
      m.rideId
    );



  if(!r){
    return;
  }



  if(
    r.status !== 'searching' &&
    r.driverId !== uid &&
    r.passengerId !== uid
  ){

    return;

  }



  clearTimeout(
    r.offerTimer
  );


  r.offerTimer =
    null;


  r.status =
    'cancelled';



  r.currentDrivers =
    [];



  const p =
    users.get(
      r.passengerId
    );


  const d =
    users.get(
      r.driverId
    );



  if(p){

    p.rideId =
      null;

  }


  if(d){

    d.rideId =
      null;


    d.available =
      d.online;

  }



  send(
    p?.ws,
    {
      type:'cancelled',
      ride:r,
      message:'Ride cancelled.'
    }
  );



  send(
    d?.ws,
    {
      type:'cancelled',
      ride:r,
      message:'Ride cancelled.'
    }
  );



  count();

  return;

}



  });


  // ===============================
  // DISCONNECT
  // ===============================

  ws.on('close',()=>{


    if(!uid){
      return;
    }



    const u =
      users.get(uid);



    for(const r of rides.values()){


      if(
        r.status === 'searching' &&
        r.currentDrivers?.includes(uid)
      ){

        r.currentDrivers =
          r.currentDrivers
          .filter(
            id=>id!==uid
          );



        if(
          !r.currentDrivers.length
        ){

          offerDrivers(r);

        }

      }





      if(
        u?.rideId === r.id &&
        (
          r.passengerId === uid ||
          r.driverId === uid
        ) &&
        [
          'accepted',
          'going_to_pickup',
          'arrived',
          'started'
        ]
        .includes(
          r.status
        )
      ){


        r.status =
          'cancelled';



        const other =
          users.get(
            r.passengerId === uid
              ? r.driverId
              : r.passengerId
          );



        if(other){

          other.rideId =
            null;



          send(
            other.ws,
            {
              type:'cancelled',
              ride:r,
              message:
                'Other party disconnected.'
            }
          );

        }


      }


    }



    users.delete(uid);


    count();


  });


});



// ===============================
// START SERVER
// ===============================

server.listen(
  process.env.PORT || 3000,
  ()=>{
    console.log(
      'Transporter7 V2 ready'
    );
  }
);
