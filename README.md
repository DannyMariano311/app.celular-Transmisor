# Transmisor móvil Buses de Amagá

Aplicación Expo + TypeScript que captura la cámara trasera con `react-native-webrtc`, transmite el stream mediante WebRTC y envía telemetría GPS por Socket.IO cada 3 segundos.

## Instalación y ejecución

```bash
npm install
npx expo prebuild
npm run android
```

`react-native-webrtc` necesita un build nativo. Expo Go no es compatible con esta aplicación; usa un development build o `expo run:android`/`expo run:ios`.

El servidor debe aceptar estos eventos Socket.IO:

- Cliente emite `join`, `{ role: "transmitter" }`.
- Cliente emite `offer`, `{ offer }`.
- Cliente emite `ice-candidate`, `{ candidate }`.
- Cliente emite `telemetry`, `{ lat, lng, latitude, longitude, lon, speed, timestamp }`.
- Servidor responde `answer`, `{ answer }`, y retransmite `ice-candidate`, `{ candidate }`.

Para probar desde un teléfono físico, introduce `http://IP_LOCAL_DEL_SERVIDOR:8080` en la pantalla, no `localhost`. Si el servidor se inicia con `SSL_CERT` y `SSL_KEY`, introduce `https://IP_LOCAL_DEL_SERVIDOR:8080` y usa un certificado confiable para Android.

