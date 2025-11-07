# App Alarma (Expo + módulo nativo Android)

App de alarma y temporizador para Android, basada en React Native/Expo con código nativo Android incluido. Características:

- Crear una alarma para una fecha/hora específica (una sola vez)
- Crear un temporizador (1–60 min)
- Texto/nota opcional
- Editar alarmas (fecha/hora y texto). En temporizador, editar texto
- Eliminar elementos activos
- Al disparar: Posponer 5/10/15 min o Desactivar
- Historial con conteo de pospuestos

Diseño simple en tonos azules, pensado para “abrir, poner y listo”.

## Requisitos

- Node.js 18 o 20 (recomendado 20.x)
- Android SDK instalado (Gradle/SDK Tools). Emulador o dispositivo físico
- Expo CLI (opcional para Metro/dev), pero OJO: esta app usa código nativo propio, por lo que Expo Go no es suficiente. Se requiere build nativo (Gradle) o Development Build.

## Instalación y ejecución (desarrollo)

```bash
# 1) Dependencias JS
npm install

# 2) Compilar e instalar en Android (debug)
cd android
./gradlew installDebug

# (Opcional) Iniciar Metro para recarga JS
cd ..
npx expo start
```

Importante: debido al módulo nativo Android, la app no corre en Expo Go. Usa un emulador/dispositivo y compila con Gradle o crea una Development Build.

## Builds Release

```bash
# APK release e instalar en dispositivo
cd android
./gradlew assembleRelease
./gradlew installRelease

# Generar AAB para Play Store
./gradlew bundleRelease
# Salida: android/app/build/outputs/bundle/release/app-release.aab
```

Firma: actualmente la configuración de `release` utiliza el keystore de debug (solo para pruebas). Para publicar:

1) Genera una keystore de producción (NO la subas al repo):
   - keytool -genkeypair -v -storetype JKS -keystore my-release-key.jks -alias my-alias -keyalg RSA -keysize 2048 -validity 10000
2) Configura `signingConfigs.release` en `android/app/build.gradle` apuntando a tu keystore y variables (usa `gradle.properties` o env vars)
3) Recompila `bundleRelease` para subir a Play Console

## Permisos y comportamiento Android

- Notificaciones: se solicita permiso en Android 13+ para mostrar notificaciones (expo-notifications)
- Alarmas exactas: en Android 12+ (API 31) se solicita “Schedule exact alarms”. La app abre el intent de sistema si no está concedido
- Sonido/actividad de pantalla completa: al disparar, se lanza `AlarmRingingActivity` (pantalla nativa), reproduce tono de alarma y muestra botones de Posponer/Desactivar, incluso sobre la pantalla de bloqueo

### Posponer/Desactivar y sincronización con la UI

- La actividad nativa emite un evento (`alarmActivityAction`) con `id`, `action` y `triggerAt` (en caso de posponer)
- `App.tsx` escucha el evento vía `DeviceEventEmitter` y actualiza la lista de Activas
- Para evitar carreras en arranque (evento llega antes de cargar AsyncStorage), se usa una cola de acciones pendientes: al cargar datos, la UI procesa y refleja el nuevo horario

## Arquitectura y archivos relevantes

- `App.tsx`: UI, estado (Activas/Historial), persistencia en AsyncStorage, manejo de notificaciones y eventos nativos
- `android/app/src/main/java/com/anonymous/appalarma/AlarmModule.kt`: Módulo nativo RN
  - Programa alarmas/temporizadores con `AlarmManager.setExactAndAllowWhileIdle`
  - Registra canal de notificación y receptor interno para acciones
  - Entrega acciones a JS vía `DeviceEventEmitter`
- `android/app/src/main/java/com/anonymous/appalarma/AlarmReceiver.kt`: Receiver que lanza la actividad de “sonando”
- `android/app/src/main/java/com/anonymous/appalarma/AlarmRingingActivity.kt`: Actividad de pantalla completa con botones de posponer/desactivar y reproducción de tono

Claves de almacenamiento:
- Activas: `appalarma.activeItems.v1`
- Historial: `appalarma.historyItems.v1`

## Git: qué se versiona

- La carpeta `android/` SE versiona porque contiene código nativo propio (módulo/actividad/receptor)
- En `.gitignore` se excluyen solo artefactos de build: `android/**/build/`, `android/.gradle/`, `*.apk`, `*.aab`, `debug.keystore`, etc.

## Solución de problemas

- “Posponer no actualiza la hora en Activas” → corregido: hay cola anti-carreras; si persiste, abre la app y espera 1–2 s para que procese acciones pendientes
- “No suena/No muestra sobre lock screen” → revisa permisos de notificaciones y exact alarms. En algunos fabricantes (ej. Xiaomi) desactiva optimizaciones de batería para la app
- “NODE_ENV warning en build” → es un warning de `expo-constants`. No bloquea el build
- “Expo Go no abre la app” → esta app requiere build nativo o Development Build por tener módulo nativo

## Roadmap opcional

- Repeticiones de alarma (diaria, días de semana)
- UI para seleccionar tono propio
- Icono de notificación y recursos adaptativos
- Integración iOS (si se añade nativo para iOS, conviene versionar `ios/`)
