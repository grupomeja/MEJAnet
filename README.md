# Orden de Carga en línea

Formulario web para que los trabajadores llenen la ORDEN DE CARGA desde el celular o la computadora, sin contraseña.
Al enviar, la orden se **guarda** y se **manda por correo en PDF**.

- `/`  → formulario para los trabajadores
- `/admin` → lista de órdenes recibidas y PDF de cada una (pide contraseña; el usuario puede ser cualquiera)

## Variables de entorno (en Render → Environment)

| Variable | Para qué sirve |
|---|---|
| `DATABASE_URL` | Base de datos Postgres donde se guardan las órdenes (el `render.yaml` la crea y conecta sola) |
| `ADMIN_USER` | Usuario para entrar al tablero (por defecto `amedina`) |
| `ADMIN_PASSWORD` | Contraseña para entrar al tablero y crear órdenes |
| `RESEND_API_KEY` | Clave de Resend (https://resend.com) para enviar el correo por HTTPS. Necesaria en el plan gratis de Render, que bloquea SMTP |
| `MAIL_FROM` | Opcional. Remitente; por defecto `Orden de Carga <onboarding@resend.dev>` |
| `SMTP_USER` | Solo si no usas Resend (SMTP; no funciona en el plan gratis de Render) |
| `SMTP_PASS` | Contraseña de aplicación de ese correo (no la contraseña normal) |
| `MAIL_TO` | Correo que recibe el aviso (varios, separados por coma) |
| `SMTP_HOST` / `SMTP_PORT` | Opcionales. Por defecto `smtp.gmail.com` / `465` |

Sin `DATABASE_URL` las órdenes se guardan en un archivo local, que se borra cuando Render reinicia el servicio gratis.

## Guardar los PDF en Google Drive (opcional)

1. Abre https://script.google.com con la cuenta dueña de la carpeta, crea un proyecto nuevo y pega el contenido de `apps-script/Code.gs`.
2. Cambia `PON_AQUI_TU_CLAVE` por una clave inventada por ti.
3. Implementar → Nueva implementación → tipo "Aplicación web". Ejecutar como: **Yo**. Quién tiene acceso: **Cualquier persona**. Autoriza los permisos y copia la URL que termina en `/exec`.
4. En Render agrega `DRIVE_WEBHOOK_URL` (esa URL) y `DRIVE_TOKEN` (la misma clave del paso 2).

## Entradas Bodega

- `/entradas-bodega` → tablero de entradas (pide contraseña). Cada celda se edita con un clic.
- `/entradas-bodega/nueva` → formulario "Agregar Nuevo".
- La primera vez que arranca con la tabla vacía, carga los registros de `seed/entradas_bodega.json` (primera pestaña del Excel "-STATUS- 2026 -").
- Cada registro nuevo o editado se copia a la hoja de Google "Entradas Bodega" mediante el mismo Apps Script de Drive (`apps-script/Code.gs`, acciones `eb_fila` y `eb_todo`). El botón "Actualizar Google Sheet" del tablero manda todos los registros.
