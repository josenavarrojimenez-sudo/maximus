---
name: Configuración de Audio - ElevenLabs
description: Configuración TTS/STT de Maximus usando ElevenLabs API, voice ID, modelo, formato y control emocional
type: reference
---

# Configuración de Audio

## TTS (Text-to-Speech)
- **Servicio:** ElevenLabs API
- **Voice ID:** `7MbkkemMzdIlG5LyIhul`
- **Modelo TTS:** `eleven_v3`
- **Formato:** `opus_48000_128` (OGG Opus - nativo WhatsApp)
- **Compatibilidad:** 100% iOS, 100% Android, 100% WhatsApp

### Configuración de Voz
- stability: 0.4 (más expresivo/variable)
- similarity_boost: 0.75 (fiel a voz original)
- style: 0.5 (expresión emocional media)
- use_speaker_boost: True (refuerza claridad)

## STT (Speech-to-Text)
- **Primary:** ElevenLabs Scribe V2 con `eleven_multilingual_v2`
- **Idioma:** Español auto-detectado
- **API Key:** Pedirla a Jose

## Control Emocional con Corchetes (V3)
- [risas] - Sonidos de risa
- [susurros] - Hablar suave
- [triste] - Tono melancólico
- [alegre] - Tono entusiasta
- [énfasis] - Enfatizar la frase siguiente

Ejemplo: `[alegre] ¡Hola Jose! [susurros] Esto es confidencial.`
