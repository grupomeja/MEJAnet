# Orden de Carga en línea

Formulario web para que los trabajadores llenen la ORDEN DE CARGA desde el celular o la computadora, sin contraseña.
Al enviar, la orden se **guarda** y se **manda por correo en PDF**.

- `/` → página principal: inicio de sesión (logo, "MEJAnet v1.0", usuario y contraseña). Si ya hay sesión, pasa directo a `/modulos`.
- `/modulos` → Módulos (logo y botones: Orden de Carga, Entradas Bodega, Cotizador) y botón "Cerrar sesión".
- Al entrar se guarda una cookie que dura 1 año y se renueva en cada visita, así que no se vuelve a pedir en ese navegador. Cambiar la contraseña de un usuario cierra sus sesiones; cambiar `SESSION_SECRET` cierra todas.
- `/logout` → cierra la sesión en ese navegador y regresa a `/`.
- Todas las demás secciones (Orden de Carga, Entradas Bodega, Cotizador) usan la misma sesión.

## Variables de entorno (en Render → Environment)

| Variable | Para qué sirve |
|---|---|
| `DATABASE_URL` | Base de datos Postgres donde se guardan las órdenes (el `render.yaml` la crea y conecta sola) |
| `ADMIN_USER` | Usuario principal (por defecto `amedina`) |
| `USUARIOS` | Otros usuarios con el mismo acceso, formato `usuario:contraseña,usuario2:contraseña2`. El usuario distingue mayúsculas. Cambiar la contraseña de alguien cierra sus sesiones abiertas |
| `ADMIN_PASSWORD` | Contraseña para entrar a MEJAnet |
| `SESSION_SECRET` | Opcional. Texto secreto extra para firmar la cookie de sesión; cambiarlo cierra todas las sesiones |
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

## Cotizador

- `/cotizador` → tablero de cotizaciones (pide contraseña): buscar, cambiar estado (BORRADOR / ENVIADA / ACEPTADA / RECHAZADA), ver PDF, duplicar y borrar.
- `/cotizador/nueva` y `/cotizador/editar/:id` → formulario "Cotización de servicios" con el mismo formato del PDF: todo lo que está dentro de celdas se edita (incluida la franja de cliente / operación / válida hasta); títulos fijos. Se puede imprimir desde el navegador en una hoja. Secciones:
  1. **Detalles del embarque**: cliente, tipo (terrestre / marítima / FFCC), tráfico (se captura a mano), fecha, válido hasta, operación, naviera, modalidad (door to door / FCL / LTL), tipo de contenedor (20ST, 40HC…) y tipo de cambio.
  2. **Desglose de cargos**: conceptos en USD o MXN. Una cotización nueva trae los conceptos marcados como *predeterminados* en el catálogo.
  3. **Impuestos aduanales**: proveedor, factura, buque, contenedores, valor, tipo de cambio, IGI, DTA, IVA, prevalidación y contraprestación. Si se dejan vacíos, el valor aduana (valor USD × T.C. + incrementables) y el IVA (16% de valor aduana + IGI + DTA) se calculan solos.
- `/cotizador/tarifas` → catálogo de conceptos (monto manual, monto fijo o fórmula). Variables de las fórmulas: `precio`, `tc`, `valor_usd`, `valor_mxn`, `valor_aduana`. Ejemplo: `max(valor_mxn * precio / 100, 5500)`.
- Folio por tipo, con numeración propia y asignado al guardar: `CT-0001` terrestre, `CM-0001` marítima, `CF-0001` ferrocarril; el PDF se genera en `/api/admin/cot/cotizaciones/:id/pdf`.
- Archivos: `cotizador.js` (datos y rutas), `cotizacion-pdf.js` (PDF), `public/formula.js` (cálculos, se usa en servidor y navegador), `admin/cotizador.html`, `admin/cotizacion.html`, `admin/cot-tarifas.html`.
- Las tablas `cot_conceptos` y `cotizaciones` se crean solas al arrancar; la primera vez se cargan los 6 conceptos de ejemplo.
