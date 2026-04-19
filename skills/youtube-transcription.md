# Skill: YouTube Transcription

**Categoría:** Extracción de contenido  
**Estado:** ✅ Funcional (probado desde IP cloud)  
**Fecha:** 2026-04-19  

---

## Descripción

Descarga la transcripción/subtítulos de cualquier video de YouTube directamente desde el servidor, sin necesidad de login ni API keys externas. Funciona desde IPs de cloud que normalmente están bloqueadas por YouTube.

---

## Solución que funciona

### Método: `yt-dlp` con `player_client=web_embedded`

YouTube bloquea requests normales desde IPs de datacenter. La clave es usar el cliente `web_embedded` que bypasea las restricciones anti-bot.

### Paso 1: Instalar yt-dlp

```bash
pip install yt-dlp
```

### Paso 2: Obtener URL del caption/subtítulo

```python
import yt_dlp
import requests

VIDEO_URL = "https://youtu.be/VIDEO_ID"

ydl_opts = {
    'skip_download': True,
    'writesubtitles': False,
    'writeautomaticsub': False,
    'quiet': True,
    'extractor_args': {
        'youtube': {
            'player_client': ['web_embedded'],
        }
    }
}

with yt_dlp.YoutubeDL(ydl_opts) as ydl:
    info = ydl.extract_info(VIDEO_URL, download=False)
    
    # Buscar subtítulos automáticos en inglés o español
    subs = info.get('automatic_captions', {})
    lang = 'en' if 'en' in subs else list(subs.keys())[0]
    caption_formats = subs[lang]
    
    # Preferir formato json3 o vtt
    caption_url = None
    for fmt in caption_formats:
        if fmt['ext'] in ['json3', 'vtt']:
            caption_url = fmt['url']
            break
```

### Paso 3: Descargar y parsear el transcript

```python
import json

# Descargar con requests normal (no necesita proxy)
response = requests.get(caption_url)
data = response.json()

# Parsear eventos de texto
transcript_parts = []
for event in data.get('events', []):
    for seg in event.get('segs', []):
        text = seg.get('utf8', '').strip()
        if text and text != '\n':
            transcript_parts.append(text)

full_transcript = ' '.join(transcript_parts)
print(f"Transcript: {len(full_transcript)} caracteres")
```

---

## Script completo listo para usar

```python
#!/usr/bin/env python3
"""
YouTube Transcript Extractor
Funciona desde IPs de cloud via yt-dlp web_embedded client
"""
import yt_dlp
import requests
import sys

def get_youtube_transcript(video_url: str, lang: str = None) -> str:
    ydl_opts = {
        'skip_download': True,
        'quiet': True,
        'extractor_args': {
            'youtube': {
                'player_client': ['web_embedded'],
            }
        }
    }
    
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(video_url, download=False)
    
    # Intentar subtítulos automáticos primero, luego manuales
    subs = info.get('automatic_captions', {}) or info.get('subtitles', {})
    if not subs:
        raise Exception("No hay subtítulos/captions disponibles para este video")
    
    # Seleccionar idioma
    if lang and lang in subs:
        selected_lang = lang
    elif 'en' in subs:
        selected_lang = 'en'
    elif 'es' in subs:
        selected_lang = 'es'
    else:
        selected_lang = list(subs.keys())[0]
    
    # Obtener URL del formato json3
    caption_url = None
    for fmt in subs[selected_lang]:
        if fmt.get('ext') == 'json3':
            caption_url = fmt['url']
            break
    
    if not caption_url:
        # Fallback a cualquier formato
        caption_url = subs[selected_lang][0]['url']
    
    # Descargar y parsear
    response = requests.get(caption_url, timeout=30)
    data = response.json()
    
    parts = []
    for event in data.get('events', []):
        for seg in event.get('segs', []):
            text = seg.get('utf8', '').strip()
            if text and text != '\n':
                parts.append(text)
    
    return ' '.join(parts)


if __name__ == '__main__':
    url = sys.argv[1] if len(sys.argv) > 1 else "https://youtu.be/dQw4w9WgXcQ"
    transcript = get_youtube_transcript(url)
    print(f"[OK] {len(transcript)} caracteres extraídos")
    print(transcript[:500] + "..." if len(transcript) > 500 else transcript)
```

---

## Uso en el bot (Maximus)

```javascript
// Desde bot.js, llamar el script Python
const { execSync } = require('child_process');

function getYouTubeTranscript(url) {
    const result = execSync(`python3 /app/skills/youtube_transcript.py "${url}"`, {
        timeout: 60000,
        encoding: 'utf8'
    });
    return result;
}
```

---

## Notas importantes

- **Requiere:** `pip install yt-dlp requests`
- **No requiere:** API keys, login, proxies
- **Funciona con:** Videos que tienen subtítulos automáticos (la mayoría en inglés/español)
- **No funciona con:** Videos sin subtítulos, videos privados, videos con captions desactivados
- **Idiomas soportados:** Cualquier idioma disponible en el video (auto-detect)
- **Rendimiento:** ~3-10 segundos por video dependiendo de la conexión

## Alternativa con Tor (si yt-dlp falla)

Si el método principal falla, se puede usar Tor como proxy:

```bash
apt-get install -y tor
service tor start
# Luego usar SOCKS5 proxy: 127.0.0.1:9050
```

```python
proxies = {'http': 'socks5h://127.0.0.1:9050', 'https': 'socks5h://127.0.0.1:9050'}
response = requests.get(caption_url, proxies=proxies)
```

---

*Documentado por Maximus — 19 abril 2026*
