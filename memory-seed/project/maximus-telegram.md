# Bot Maximus Telegram

## Infraestructura
- Corre en VPS Hostinger (8GB RAM, 2 CPU)
- Docker container con restart: always
- OpenClaude CLI como motor de IA
- ElevenLabs para TTS/STT
- FFmpeg para procesamiento de audio

## Estado actual
- Bot funcional con texto y audio
- Sistema de memoria persistente implementado (Fase 1)
- Cola de mensajes secuencial
- Timeout de 5 minutos para OpenClaude
- Chunking de TTS para textos largos

## Proximos pasos (Fase 2)
- Resumenes automaticos de conversaciones viejas
- Que Maximus pueda escribir su propia memoria
- Consolidacion de journal a canon
- Busqueda semantica
