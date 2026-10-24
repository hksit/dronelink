# DroneLink flight data protocol (v1)

DJI's RTMP live stream carries only the picture. DroneLink Mobile (or any app) sends
flight data to DroneLink separately, as small JSON messages over **UDP port 41234**.
The video still goes to DroneLink over RTMP (`rtmp://<computer>/live/drone`).

## Find DroneLink on the network

The phone sends this to the broadcast address of its Wi-Fi or hotspot, port 41234:

```json
{"dl":"discover","v":1,"app":"DroneLink Mobile"}
```

Every DroneLink on that network replies to the sender's address and port:

```json
{"dl":"here","v":1,"name":"GAGAN-PC","host":"192.168.1.110","rtmp":"rtmp://192.168.1.110/live/drone","version":"1.1.0"}
```

`host` is the computer's address on the same network as the phone.

## Flight data

Send to `host`, port 41234, about 5 times a second. Every field is optional.

```json
{"dl":"tel","v":1,"alt":72.4,"hdg":47,"hs":6.3,"vs":0.5,"dist":115,"lat":-31.9497,"lon":115.8613,"bat":64,"sats":18,"flying":true,"model":"Mini 4 Pro","sim":false}
```

| Field | Meaning | Unit |
|---|---|---|
| `alt` | Height above the take-off point | metres |
| `hdg` | Compass heading, 0 = north, clockwise | degrees |
| `hs` | Horizontal speed | m/s |
| `vs` | Vertical speed, up is positive | m/s |
| `dist` | Distance from the home point | metres |
| `lat`, `lon` | Drone position | degrees |
| `bat` | Drone battery | % |
| `sats` | GPS satellites | count |
| `flying` | In the air | true/false |
| `model` | Drone name shown in DroneLink | text, max 40 |
| `sim` | Data comes from DJI's simulator | true/false |

DroneLink treats the data as gone when nothing arrives for 3 seconds. Messages
larger than 2 KB, or with `v` other than 1, are ignored.
