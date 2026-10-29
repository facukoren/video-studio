# Kavion Video Studio

Editor de videos autoalojado: subís una grabación o pegás un enlace de Drive y el sistema transcribe, recorta pausas y repeticiones, propone un montaje, agrega subtítulos, motion graphics y B-roll, verifica el resultado y lo entrega en **tu propia carpeta de Google Drive**.

**Cada instalación utiliza sus propias cuentas.** Este repositorio no incluye credenciales, sesiones, videos de ejemplo privados ni acceso al servidor del autor. El código es MIT; los servicios externos pueden cobrar por su uso.

## Qué incluye

- Panel web en español con carga directa, progreso, historial y configuración de conexiones.
- WhisperX large-v3 en español, tiempos por palabra y recuperación de alineación en Modal.
- Edición y crítica visual mediante la sesión local de Codex, modelo `gpt-6-astra` con razonamiento `high`.
- Render con FFmpeg y HyperFrames, B-roll mediante Higgsfield y comprobaciones antes de entregar.
- Cola persistente con checkpoints para retomar trabajos y evitar repetir operaciones pagadas cuando se conserva su identificador.
- Hasta 2 GiB y 10 minutos por original. Conserva las dimensiones y exporta a SDR a 30 fps.

## Requisitos

Linux o WSL2, Node.js **24 o superior**, Python 3.11+, FFmpeg/ffprobe y `flock` (util-linux). El panel y el worker deben permanecer encendidos; la transcripción y el render se ejecutan en Modal.

Necesitás tus propias cuentas de Google Drive, Modal, Higgsfield y una sesión de Codex que anuncie `gpt-6-astra` / `high`. El modelo está fijado: si tu cuenta no tiene acceso, la edición no estará disponible. El panel se puede iniciar antes de conectar los proveedores.

## Inicio rápido

```sh
git clone https://github.com/facukoren/video-studio.git
cd video-studio
npm ci
cp .env.example .env
chmod 600 .env
npm start
```

Abrí [http://127.0.0.1:4142](http://127.0.0.1:4142). En una instalación nueva verás las conexiones pendientes. Completá [la configuración de tus cuentas](docs/SETUP.md), guardá un límite de créditos y después iniciá el worker en otra terminal:

```sh
npm run worker
```

Usá el panel para cargar tu video o un enlace de Drive. Conservá la pestaña abierta hasta que termine una carga directa; después el worker continúa aunque cierres el navegador. Un corte de conexión durante la transferencia requiere repetir la carga completa. El original no se sobrescribe.

## Acceso y seguridad

La configuración predeterminada escucha solamente en `127.0.0.1`. Para acceder desde otro equipo, usá un túnel SSH a ese puerto; no publiques el puerto ni un proxy hacia él sin autenticación. Esta es una aplicación para un operador o un equipo de confianza: todos comparten la misma cola, videos y cuentas de proveedores.

`.env`, credenciales de Google, sesiones CLI, bases de datos y archivos de `runtime/` quedan fuera de Git. El servidor aplica validación de Host, sesiones, CSRF, estado OAuth y cabeceras de seguridad. Si configurás `APP_ACCESS_TOKEN`, será obligatorio también para conexiones locales. El acceso mediante token está orientado a clientes HTTP que envían `Authorization: Bearer ...`; no hay pantalla de inicio de sesión por contraseña. [Modelo de seguridad y límites](SECURITY.md).

El procesamiento envía videos a Modal, texto y cuadros a Codex, prompts a Higgsfield y originales/resultados a Google Drive. Cada operador es responsable de obtener permiso y configurar la retención en esas cuentas. [Datos y retención](docs/PRIVACY.md).

## Desarrollo

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r scripts/requirements-alignment.txt
npm ci
npm test
npm run check
npm audit
```

Las pruebas usan proveedores simulados y medios sintéticos, sin tus credenciales ni generaciones pagadas. FFmpeg debe estar en `PATH` o en `FFMPEG_PATH`. Para comprobar también el navegador:

```sh
npx playwright install chromium
npm run test:browser
node scripts/upload-browser-check.mjs
```

Los resultados y sus límites están en [la verificación de la publicación](docs/VERIFICATION.md). Las pruebas de la aplicación y de los contratos remotos no certifican un despliegue real en tus cuentas. El servicio ASR incluido necesita desplegarse y validarse en tu cuenta de Modal; la instalación no lanza trabajos pagados automáticamente.

## Licencia

[MIT](LICENSE) para el código y los efectos sintéticos originales. Las fuentes conservan sus [licencias y avisos](THIRD_PARTY_NOTICES.md). Los servicios, CLIs y modelos externos tienen sus propios términos y cuotas.
