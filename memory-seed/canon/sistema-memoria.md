# Sistema de Memoria de Maximus

## Arquitectura (Fase 1)
- SQLite para episodios/conversaciones crudas
- Markdown para memoria estructurada
- Docker volume persistente

## Capas
1. **Identidad fija**: system-prompt.txt (personalidad, tono, reglas)
2. **Estado actual**: historial reciente de conversacion (SQLite)
3. **Memoria episodica**: cada intercambio guardado en SQLite
4. **Journal diario**: archivo markdown por dia con resumen de interacciones
5. **Canon**: verdad consolidada en markdown (esta carpeta)
6. **Preferencias de usuario**: en memory/user/
7. **Decisiones**: en memory/decisions/

## Flujo antes de responder
1. Leer historial reciente
2. Revisar canon relevante
3. Revisar journal del dia
4. Revisar preferencias
5. Responder con toda esa informacion como contexto

## Inspirado en
- gbrain: verdad consolidada por tema
- lossless-claw: no perder contexto
- qmd: busqueda eficiente
- MemPalace: recuerdos crudos con estructura
