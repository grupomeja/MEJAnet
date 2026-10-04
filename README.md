# Orden de Carga en línea

Formulario web para que los trabajadores llenen la ORDEN DE CARGA desde el celular o la computadora, sin contraseña.
Al enviar, la orden se **guarda** y se **manda por correo en PDF**.

- `/`  → formulario para los trabajadores
- `/admin` → lista de órdenes recibidas y PDF de cada una (pide contraseña; el usuario puede ser cualquiera)

## Variables de entorno (en Render → Environment)

| Variable | Para qué sirve |
|---|---|
| `DATABASE_URL` | Base de datos Postgres donde se guardan las órdenes (el `render.yaml` la crea y conecta sola) |
| `ADMIN_PASSWORD` | Contraseña para entrar a `/admin` |
| `RESEND_API_KEY` | Clave de Resend (https://resend.com) para enviar el correo por HTTPS. Necesaria en el plan gratis de Render, que bloquea SMTP |
| `MAIL_FROM` | Opcional. Remitente; por defecto `Orden de Carga <onboarding@resend.dev>` |
| `SMTP_USER` | Solo si no usas Resend (SMTP; no funciona en el plan gratis de Render) |
| `SMTP_PASS` | Contraseña de aplicación de ese correo (no la contraseña normal) |
| `MAIL_TO` | Correo que recibe el aviso (varios, separados por coma) |
| `SMTP_HOST` / `SMTP_PORT` | Opcionales. Por defecto `smtp.gmail.com` / `465` |

Sin `DATABASE_URL` las órdenes se guardan en un archivo local, que se borra cuando Render reinicia el servicio gratis.
