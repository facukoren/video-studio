# Seguridad

## Uso previsto

Instalación personal o de un equipo de confianza, en localhost. La aplicación comparte cola, archivos y cuentas externas. No implementa separación entre clientes ni es un servicio SaaS multiusuario. No alojes instancias abiertas para desconocidos.

Para el navegador se recomienda `HOST=127.0.0.1` y un túnel SSH si necesitás acceso remoto. Las peticiones de un proxy local aparecen como locales: un proxy publicado necesita su propia autenticación. El servidor no confía en cabeceras `X-Forwarded-*` como prueba de identidad. Un binding distinto de loopback requiere `APP_ACCESS_TOKEN` de al menos 32 caracteres; al configurar un token, también se exige en localhost. La API admite Bearer y una sesión autenticada creada desde `/api/status` con Bearer; no hay formulario de login.

`BASE_URL` define el origen exacto que se valida para Host y CSRF. Todos los cambios de API requieren sesión, origen correcto y token CSRF. No desactives estas comprobaciones para solucionar un problema de proxy.

## Credenciales y archivos privados

- Completá `.env` localmente y mantenelo con permisos 0600.
- Mantené `DATA_DIR`, JSON OAuth, sesiones de Codex/Higgsfield/Modal, medios y backups fuera de `public/` y del control de versiones. No uses este repositorio como directorio de credenciales.
- El directorio de datos nuevo usa 0700 y los procesos del servidor usan umask 0077; los archivos OAuth y la base de datos usan 0600.
- Git ignora archivos de entorno, sesiones, claves, bases, logs y medios de runtime. El contexto Docker admite solamente código, dependencias fijadas y assets.
- La publicación inicial utiliza historial nuevo y recursos de ejemplo, sin importar el historial ni los archivos de operación de la instalación original.

Los textos del video y las salidas del modelo se consideran datos. El compilador valida un esquema, no ejecuta HTML o comandos propuestos por el modelo. El cliente editorial desactiva herramientas y evita heredar claves de otros proveedores. Estas medidas no eliminan todos los riesgos de entradas maliciosas o dependencias externas; usá cuentas dedicadas y archivos de confianza.

## Comprobaciones antes de publicar cambios

```sh
npm run check
npm test
npm audit
gitleaks dir . --redact=100
gitleaks git . --redact=100
```

Revisá también los archivos preparados con `git diff --cached --stat`. El escaneo automático no reemplaza revisar datos personales, enlaces privados y permisos. Si publicaste una clave por error, revocala en su proveedor antes de limpiar el historial.

## Reportar vulnerabilidades

Usá la sección Security del repositorio si tiene habilitado el reporte privado de vulnerabilidades. Si no está disponible, abrí un issue solicitando un canal privado **sin incluir secretos, videos ni instrucciones de explotación sensibles**. No publiques tus tokens ni logs de autenticación en issues.
