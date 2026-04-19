# Skill: Uber Eats Scraper

**Categoría:** Scraping especializado
**Estado:** ✅ Funcional (probado 2026-04-19)
**Fecha:** 2026-04-19

---

## Descripción

Extrae el menú completo de cualquier restaurante en Uber Eats directamente desde la API interna de Uber Eats, sin necesidad de browser ni Playwright. Obtiene productos, precios, categorías, descripciones e imágenes.

---

## Por qué funciona (técnica clave)

Uber Eats bloquea scrapers con Cloudflare en el frontend, pero su **API interna** `POST /api/getStoreV1` acepta requests con `x-csrf-token: x` y una cookie de ubicación falsa. El UUID real del store se obtiene decodificando en base64 el ID que aparece en la URL.

---

## Paso 1: Decodificar el Store UUID

La URL de Uber Eats tiene formato:
`https://www.ubereats.com/cr/store/nombre/BASE64ID`

```python
import base64, uuid

store_id_b64 = "SiqE6yVsTP6lbERei52Fmg"  # ID de la URL
decoded = base64.b64decode(store_id_b64 + "==")
store_uuid = str(uuid.UUID(bytes=decoded[:16]))
# → "4a2a84eb-256c-4cfe-a56c-445e8b9d859a"
```

---

## Paso 2: Llamar a la API

```python
import requests, json

STORE_UUID = "4a2a84eb-256c-4cfe-a56c-445e8b9d859a"

response = requests.post(
    "https://www.ubereats.com/api/getStoreV1",
    headers={
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
        "x-csrf-token": "x",
        "Cookie": "uev2.loc=%7B%22address%22%3A%7B%22address1%22%3A%22San%20Jos%C3%A9%22%2C%22city%22%3A%22San%20Jos%C3%A9%22%2C%22country%22%3A%22CR%22%7D%2C%22latitude%22%3A9.9281%2C%22longitude%22%3A-84.0907%7D"
    },
    json={"storeUuid": STORE_UUID, "diningMode": "DELIVERY"},
    verify=False
)

data = response.json()["data"]
```

---

## Paso 3: Extraer menú completo

```python
catalog = data["catalogSectionsMap"]
section_key = list(catalog.keys())[0]
sections = catalog[section_key]

menu = []
images = []

for section in sections:
    payload = section.get("payload", {})
    std = payload.get("standardItemsPayload", {})
    title = std.get("title", {})
    cat_name = title.get("text", "") if isinstance(title, dict) else str(title)
    items_raw = std.get("catalogItems", [])

    category = {"categoria": cat_name, "items": []}

    for item in items_raw:
        price_crc = item.get("price", 0) / 100
        item_data = {
            "nombre": item.get("title", ""),
            "descripcion": item.get("itemDescription", ""),
            "precio_crc": price_crc,
            "precio_display": f"₡{price_crc:,.0f}",
            "imagen_url": item.get("imageUrl", ""),
            "uuid": item.get("uuid", ""),
            "tiene_variantes": item.get("hasCustomizations", False),
        }
        if item_data["imagen_url"]:
            images.append({"nombre": item_data["nombre"], "url": item_data["imagen_url"]})
        category["items"].append(item_data)

    menu.append(category)

print(f"Categorías: {len(menu)}, Items: {sum(len(c['items']) for c in menu)}")
```

---

## Paso 4: Descargar imágenes

```python
import urllib.request, ssl, os

ssl_ctx = ssl.create_default_context()
ssl_ctx.check_hostname = False
ssl_ctx.verify_mode = ssl.CERT_NONE

os.makedirs("imagenes", exist_ok=True)

for i, img in enumerate(images):
    url = img["url"]
    nombre = img["nombre"].replace("/", "-").replace(" ", "_")[:40]
    filename = f"imagenes/{i+1:03d}_{nombre}.jpeg"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, context=ssl_ctx, timeout=10) as r:
            with open(filename, "wb") as f:
                f.write(r.read())
    except:
        pass
```

---

## Resultado obtenido (El Tejano, San José CR)

- **22 categorías** encontradas
- **129 productos** extraídos
- **47 imágenes** descargadas
- Precios en CRC (colones costarricenses)
- Sin browser, sin Playwright, sin API key

---

## Notas importantes

- La cookie de ubicación (`uev2.loc`) debe ser válida para el país del restaurante
- El campo `price` está en centavos (dividir entre 100 para obtener el precio real)
- Si el store tiene paginación (`paginationEnabled: true`), pueden haber más items fuera del primer batch
- Funciona sin SSL verification (`verify=False`) desde IPs de datacenter

---

## Cuándo usar este skill

- Usuario pide extraer el menú de un restaurante de Uber Eats
- Necesitás precios, productos o imágenes de Uber Eats
- Tenés la URL de un store de Uber Eats

