// Número de orden de carga: 4 dígitos con ceros a la izquierda (0001, 0002, ...)
const formatoOC = (id) => String(id).padStart(4, '0');
module.exports = { formatoOC };
