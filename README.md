# App Alarma (Expo)

App minimalista para Android hecha con Expo. Permite:

- Crear una alarma para una fecha/hora específica (una sola vez)
- Crear un temporizador de hasta 60 minutos
- Texto/nota opcional en cada uno
- Editar alarmas (fecha/hora y texto); los temporizadores solo permiten editar el texto
- Eliminar elementos activos
- Al dispararse, puedes Posponer 5/10/15 minutos o Desactivar
- Al desactivar, pasa a Historial y se elimina de Activas

Diseño en tonalidades azules y enfoque "abrir, poner y listo".

## Requisitos

- Node.js 20.x recomendado (las toolchains de RN/Metro nuevas lo piden). Con Node 18 funciona con warnings.
- Dispositivo Android (o emulador) con la app de Expo Go o un Dev Client.

## Ejecutar

```bash
# Instalar dependencias (ya se instalaron al crear el proyecto)
npm install

# Iniciar el servidor de desarrollo
npx expo start

# Android: abre la app con Expo Go (escaneando QR) o usa 'a' para emulador.
```

## Notas importantes (Android)

- La app usa `expo-notifications` para programar notificaciones con sonido y alta prioridad.
- Esto se acerca al comportamiento de una alarma nativa, pero por limitaciones de Expo/Android:
  - No muestra pantalla de alarma de pantalla completa automáticamente sobre la pantalla de bloqueo.
  - No puede ignorar el modo No molestar (DND) ni garantizar volumen máximo.
- Al tocar la notificación, la app abre una pantalla de "sonando" donde puedes posponer/descartar.

Si deseas comportamiento 100% nativo (pantalla completa tipo reloj, `AlarmManager#setAlarmClock`, exact alarms, etc.), puedo migrar este proyecto a un build de desarrollo con un plugin nativo para Android. Eso requiere una **development build** de Expo o prebuild con EAS y permisos especiales.

## Estructura

- `App.tsx`: UI y lógica principal (crear, listar, historial, posponer, desactivar)
- AsyncStorage: persistencia de elementos activos e historial
- `expo-notifications`: canal Android `alarm` con prioridad máxima

## Limitaciones implementadas según requisitos

- Alarmas son de una sola vez (sin repetir)
- Temporizadores no se reprograman (solo texto y eliminar)
- Al desactivar, se mueven a historial

## Siguientes pasos opcionales

- Development build + módulo nativo para pantalla completa y `AlarmManager`
- Sonido de alarma en bucle dentro de la app (requiere `expo-av` y un asset de audio)
- Icono de notificación personalizado para el canal
