# Sistema de Memoria de Maximus

## Arquitectura (Fase 1)
- SQLite para episodios/conversaciones crudas (WAL mode + FTS5)
- Markdown para memoria estructurada
- Docker volume persistente

## Capas
1. **Identidad fija**: system-prompt.txt (personalidad, tono, reglas)
2. **Estado actual**: historial reciente de conversación (SQLite)
3. **Memoria episódica**: cada intercambio guardado en SQLite
4. **Journal diario**: archivo markdown por día con resumen de interacciones
5. **Canon**: verdad consolidada en markdown (esta carpeta)
6. **Preferencias de usuario**: en memory/user/
7. **Decisiones**: en memory/decisions/
8. **Inbox**: auto-memorias escritas por Maximus via bloques [REMEMBER]

## Flujo antes de responder
1. Leer historial reciente (sin límite artificial - el proveedor LLM define)
2. Revisar canon relevante
3. Revisar journal del día
4. Revisar preferencias
5. Revisar proyectos activos
6. Revisar decisiones clave
7. Revisar inbox pendiente
8. Responder con toda esa información como contexto

## Principio fundamental: Sin límites artificiales
- El contexto se inyecta COMPLETO, sin truncado
- No se cortan mensajes individuales
- No hay cap de mensajes recientes
- El LLM (sea Sonnet, Opus, o cualquier otro) maneja su propio context window
- Si se cambia de proveedor, la memoria no necesita ajuste

## Config dinámica (via .env)
- Modelo y esfuerzo son variables de entorno, no hardcoded
- Cambiar de proveedor = cambiar .env + docker compose up

## Inspirado en
- gbrain: verdad consolidada por tema
- lossless-claw: no perder contexto
- qmd: búsqueda eficiente
- MemPalace: recuerdos crudos con estructura
