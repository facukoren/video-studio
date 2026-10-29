# Contrato remoto

El coordinador usa funciones privadas autenticadas con el SDK de Modal. No comparte tokens de Google, Higgsfield o Codex con los contenedores de medios.

| Aplicación | Función o recurso |
| --- | --- |
| `kavion-whisperx-real` | `transcribe_file(remote_path, filename, language='es', model_name='large-v3', enable_diarization=False)` |
| `kavion-word-alignment` | `align_words_v1(remote_path, source_hash, raw_hash, payload)` |
| `kavion-video-studio-media` | `run_media_astra_v3_<fingerprint>` |
| `kavion-whisperx-inputs` | NetworkFileSystem privado para fuentes |
| `kavion-whisperx-hf-cache` | Volumen privado para modelos |
| `kavion-video-studio-media` | Volumen privado para medios y recibos |

Los despliegues incluidos usan esos nombres dentro de la cuenta del operador. Conservá los nombres de ASR y alineación, porque forman parte del contrato validado por el cliente. Si personalizás `MODAL_MEDIA_APP` o `MODAL_MEDIA_VOLUME`, actualizá también los nombres correspondientes del deploy de medios antes de desplegar.

El cliente calcula una identidad a partir de la fuente, parámetros y versión del compilador. Guarda el identificador remoto antes de consultar el resultado. Si se interrumpe una consulta, retoma ese identificador; si no puede saber si un envío llegó, bloquea la repetición automática para evitar gastos duplicados.

Cada revisión de calidad conserva su propio estado y reutiliza B-roll previamente pagado. Los controles técnicos y la crítica visual deben aprobar el montaje antes de entregar a Drive. La crítica analiza cuadros muestreados y no prueba todo el movimiento entre cuadros ni reemplaza escuchar el resultado.

La publicación puede comprobar localmente contratos con SDK simulado. Un despliegue real, las imágenes GPU, las cuotas de cada cuenta y la disponibilidad de proveedores requieren validación en esa instalación. No se incluye un recibo privado de producción como prueba para otras cuentas.
