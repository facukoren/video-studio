# Configuración de una instalación propia

## 1. Herramientas locales

En Debian/Ubuntu o WSL2, instalá Node 24+ y los paquetes del sistema:

```sh
sudo apt-get update
sudo apt-get install -y ffmpeg python3 python3-venv util-linux
python3 -m venv .venv
. .venv/bin/activate
pip install modal==1.6.1
npm install -g @openai/codex@0.162.1 @higgsfield/cli@1.1.24
```

Las versiones de CLI son las esperadas por esta versión del código. Podés instalarlas en un prefijo de usuario de npm si no tenés permisos globales. Todas las claves y sesiones son tuyas; nunca las subas al repositorio.

## 2. Google Drive

Creá un proyecto propio en Google Cloud, habilitá Drive API y configurá la pantalla de consentimiento. En modo de pruebas, agregá tu cuenta como usuario de prueba. Creá un cliente OAuth de tipo **Aplicación web** con este retorno exacto:

```text
http://127.0.0.1:4142/api/auth/google/callback
```

Si cambiás `BASE_URL`, actualizá también el retorno del cliente. Descargá el JSON e importalo en Configuración del panel; autorizá Drive desde allí. También podés definir `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` en `.env`.

Creá una carpeta de salida propia y copiá el ID de su URL en `DRIVE_DESTINATION_FOLDER_ID`. La carpeta queda fijada por configuración del servidor. Reiniciá API y worker después de editar `.env`. Elegila antes de iniciar trabajos; si necesitás cambiarla con una cola existente, usá un `DATA_DIR` nuevo y conservá la cola anterior para terminar sus trabajos.

El alcance OAuth actual permite acceso amplio a Drive para descargar enlaces que pegás y entregar resultados. Usá una cuenta dedicada si necesitás limitar qué contenido queda al alcance de la aplicación.

## 3. Codex

```sh
codex login
codex debug models
```

Confirmá que el catálogo de tu sesión incluye `gpt-6-astra` con razonamiento `high`. El backend utiliza ese modelo y no cambia a otro si no está disponible. `ASTRA_PATH` permite indicar el ejecutable y `ASTRA_HOME` una sesión privada diferente. El estado del panel comprueba el acceso. No copies los archivos de sesión a `public/` ni al repositorio.

## 4. Higgsfield

```sh
higgsfield auth login
higgsfield workspace list --json
```

Copiá el ID de **tu** workspace en `HIGGSFIELD_WORKSPACE_ID` y reiniciá la aplicación. Podés reconectar la cuenta desde Configuración del panel. El sistema verifica que la cuenta conectada pertenece al workspace configurado antes de gastar. Guardá un presupuesto por video en el panel; sin presupuesto no comienza una generación.

Modal y Codex tienen consumo separado del presupuesto de Higgsfield.

## 5. Modal

Activá el entorno Python de la sección 1 e iniciá sesión en **tu** cuenta:

```sh
modal token new
python -m modal deploy scripts/whisperx-modal.py
python -m modal deploy scripts/align-modal.py
python -m modal deploy scripts/media_modal.py
```

Estos comandos crean aplicaciones y almacenamiento en tu cuenta de Modal. Construir imágenes, almacenar archivos y ejecutar funciones puede generar cargos. No despliegues usando credenciales de otra persona. Si usás un entorno de Modal distinto del predeterminado, agregá `--env NOMBRE` a cada deploy y configurá `MODAL_MEDIA_ENVIRONMENT=NOMBRE`.

El primer deploy prepara WhisperX large-v3, A10 y almacenamiento `kavion-whisperx-inputs`. El segundo agrega recuperación acústica de palabras. El tercero instala el compilador de medios y sus assets; su identidad depende del código y del lockfile. Después de cambiar esos archivos, volvé a desplegar los medios para que coincidan con la instalación local.

Los nombres `kavion-*` identifican recursos que se buscan dentro de tu propia cuenta; no dan acceso a recursos de otro usuario. No hay endpoints HTTP públicos ni secretos de otros proveedores montados en esos contenedores.

En `.env`, apuntá `PYTHON_PATH` al Python de tu entorno virtual, por ejemplo `/ruta/a/video-studio/.venv/bin/python`. `MODAL_CONFIG_PATH` permite indicar tu archivo privado de autenticación si no usás su ubicación predeterminada. Más detalles: [contrato remoto](REMOTE_MEDIA.md).

## 6. Referencia visual

Usá un video propio o con permiso de uso. Guardalo en `runtime/data/style-reference/reference.mp4` o definí una ruta privada en `REFERENCE_VIDEO_PATH`. No se incluye el video de referencia de la instalación original. Si falta la referencia, el sistema se detiene antes de generar B-roll.

La plantilla actual usa un estilo editorial con paneles, subtítulos grandes y énfasis serif; estudia tu referencia para elegir contenido y encuadres dentro de ese lenguaje, no reproduce cualquier estilo de manera arbitraria.

## 7. Iniciar

```sh
npm start
# Otra terminal en el mismo directorio y con el mismo .env:
npm run worker
```

Comprobá las conexiones en el panel antes de enviar un video. Para usar los ejemplos de systemd, adaptá `WorkingDirectory`, asegurate de que Node y las CLIs estén en el `PATH` del servicio y copiá las unidades a `~/.config/systemd/user/`. Usan instalación en `~/video-studio` como ejemplo.

El Dockerfile es una alternativa avanzada: necesita volúmenes privados para datos y sesiones, API y worker en procesos separados, `APP_ACCESS_TOKEN` para su binding `0.0.0.0` y un proxy autenticado. El flujo principal documentado es Linux/WSL2 con localhost; la imagen no se presenta como un despliegue completo verificado.
