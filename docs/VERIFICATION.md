# Verificación de la publicación

Revisión realizada el 29 de octubre de 2026 sobre la copia preparada para publicación, con Node 24.16.0.

- Suite completa: 282 pruebas aprobadas, sin fallos ni pruebas omitidas.
- Pruebas de navegador: panel, conexiones simuladas, CSRF, persistencia, desktop/mobile, temas claro/oscuro y carga de un MOV sintético; aprobadas.
- Sintaxis JavaScript y Python: aprobada.
- Compatibilidad FFmpeg: el video sintético de prueba declara color HDR en sus cuadros antes de codificar y se comprueba en el Ubuntu más reciente; el remux final también conserva las etiquetas explícitas. El flujo de navegador usa Ubuntu 24.04, compatible con la versión fijada de Playwright.
- `npm audit`: no reportó vulnerabilidades conocidas en las dependencias fijadas.
- Gitleaks 8.30.1: sin hallazgos en los archivos de publicación; también se comprueba el historial nuevo antes de entregar.
- Comparación local con los valores privados de la instalación original: sin coincidencias en el código exportado. El informe no publica esos valores.
- Revisión independiente: corrigió el primer arranque sin carpeta de Drive seguido de configuración y reinicio; la prueba conserva el presupuesto y los trabajos existentes.

La publicación usa historial nuevo y una lista de archivos permitidos. Excluye entornos, sesiones, bases de datos, medios reales y documentos internos. Los efectos de sonido incluidos son sintéticos originales y las fuentes conservan sus licencias.

Estas comprobaciones no son una certificación de seguridad. No se ejecutaron generaciones pagadas, una edición completa con cuentas de terceros ni un despliegue real de la nueva imagen GPU de WhisperX. Los contratos remotos se prueban con SDK simulado; las cuentas, cuotas e imágenes remotas deben validarse por cada operador. La crítica visual analiza muestras de cuadros y no certifica todos los movimientos ni la escucha del audio.
