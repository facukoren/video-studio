# Datos y retención de cada instalación

Esta descripción corresponde al software, no ofrece acceso al servicio del autor ni reemplaza la política de privacidad que necesite cada operador.

| Destino | Información procesada |
| --- | --- |
| Tu servidor | Originales, transcripciones, planes, cuadros, cola, resultados y credenciales de tus cuentas |
| Tu cuenta de Modal | Originales y medios intermedios para transcripción, alineación, render y verificaciones |
| Tu sesión de Codex | Texto, tiempos, instrucciones y muestras visuales de fuente, referencia y montaje |
| Tu cuenta de Higgsfield | Prompts para generar B-roll y sus recursos generados |
| Tu Google Drive | Descarga de originales seleccionados y subida de resultados a tu carpeta configurada |

El worker limpia temporales locales de trabajos completados y confirmados en Drive después de 7 días y medios locales después de 30 días. Conserva registros y checkpoints editoriales. Esa limpieza no borra originales o resultados de Drive, almacenamiento de Modal, generaciones de Higgsfield ni datos retenidos por proveedores. Los trabajos fallidos se conservan para poder inspeccionarlos y retomarlos.

Definí tu propia retención remota y revisá las condiciones de cada proveedor. Para eliminar datos, revisá el directorio privado, sus copias de seguridad, el NetworkFileSystem y los volúmenes de tu cuenta de Modal, tu Drive y tu cuenta de Higgsfield. No borres medios ni checkpoints de operaciones activas sin revisar su estado: podría impedir recuperar resultados ya pagados.
