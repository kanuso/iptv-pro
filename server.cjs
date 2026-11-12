
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Readable } = require("stream");

const app = express();

const allowedOrigins = (
  process.env.FRONTEND_URL || "http://localhost:5173"
)
  .split(",")
  .map(origin => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    // Permitir solicitudes sin Origin (por ejemplo, servidor a servidor)
    if (!origin) {
      return callback(null, true);
    }

    const normalizedOrigin = origin.replace(/\/+$/, "");

    if (allowedOrigins.includes(normalizedOrigin)) {
      return callback(null, true);
    }

    console.warn("Origen bloqueado por CORS:", origin);

    return callback(null, false);
  },

  methods: ["GET", "HEAD", "POST", "OPTIONS"],

  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Range"
  ],

  exposedHeaders: [
    "Content-Length",
    "Content-Range",
    "Accept-Ranges"
  ],

  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
const PORT = process.env.PORT || 3001;

const urlStore = new Map();

const LOCAL_PROXY =
  process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// Guardar URL y generar identificador corto
function saveUrl(url) {
  const id = crypto.randomUUID();

  urlStore.set(id, {
    url,
    createdAt: Date.now(),
  });

  return `${LOCAL_PROXY}/proxy/${id}`;
}

// Validar que las direcciones sean HTTPS
const ALLOWED_HOSTS = new Set([
  "45.184.109.10",
  "jmp2.uk"
]);

function validateUrl(url) {
  const parsed = new URL(url);

  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new Error("Protocolo no permitido");
  }

  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error("Dominio no autorizado: " + parsed.hostname);
  }

  if (parsed.username || parsed.password) {
    throw new Error("Credenciales no permitidas en URL");
  }

  return parsed;
}

// Limpiar direcciones antiguas cada cierto tiempo
setInterval(() => {
  const now = Date.now();

  for (const [id, item] of urlStore.entries()) {
    if (now - item.createdAt > 30 * 60 * 1000) {
      urlStore.delete(id);
    }
  }
}, 5 * 60 * 1000);

// Crear proxy inicial
app.get("/create-proxy", (req, res) => {
  try {
    const url = req.query.url;

    if (!url || typeof url !== "string") {
      return res.status(400).json({
        error: "Falta URL",
      });
    }

    const parsed = validateUrl(url);

    // Solo se permite crear sesiones desde enlaces Pluto conocidos
 if (!ALLOWED_HOSTS.has(parsed.hostname)) {
  return res.status(403).json({
    error: "Dominio inicial no permitido",
  });
}
    const proxyUrl = saveUrl(parsed.toString());

  

    res.json({
      url: proxyUrl,
    });

  } catch (error) {
    console.error("Error creando proxy:", error.message);

    res.status(400).json({
      error: "URL inválida",
    });
  }
});

// Procesar listas HLS, audio, video y segmentos
app.get("/proxy/:id", async (req, res) => {
  try {
    const item = urlStore.get(req.params.id);

    if (!item) {
      return res.status(404).send("URL no encontrada o expirada");
    }

    const originalUrl = item.url;

    validateUrl(originalUrl);

    const headers = {
      "User-Agent": "Mozilla/5.0",
      "Accept": "*/*",
    };

    // Soporte para solicitudes parciales de video
    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    const response = await fetch(originalUrl, {
      method: "GET",
      headers,
      redirect: "follow",
    });

    if (!response.ok && response.status !== 206) {
      console.error(
        "Error del proveedor:",
        response.status,
        response.url
      );

      return res.status(response.status).send(
        "Error al obtener contenido del proveedor"
      );
    }

    const contentType =
      response.headers.get("content-type") || "";

    const finalUrl = response.url || originalUrl;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", contentType);

    if (response.status === 206) {
      res.status(206);
    }

    // Conservar cabeceras importantes para video
    const contentRange = response.headers.get("content-range");
    const acceptRanges = response.headers.get("accept-ranges");

    if (contentRange) {
      res.setHeader("Content-Range", contentRange);
    }

    if (acceptRanges) {
      res.setHeader("Accept-Ranges", acceptRanges);
    }

    // Detectar listas M3U8
    const isPlaylist =
      contentType.toLowerCase().includes("mpegurl") ||
      /\.m3u8(?:$|[?#])/i.test(finalUrl);

    if (isPlaylist) {
      const playlist = await response.text();

      if (!playlist.trimStart().startsWith("#EXTM3U")) {
        console.error("Respuesta no válida como M3U8:", finalUrl);

        return res.status(502).send(
          "El proveedor no devolvió una lista M3U8 válida"
        );
      }

      const lines = playlist.split(/\r?\n/);

      const rewritten = lines.map((line) => {
        const trimmed = line.trim();

        if (!trimmed) {
          return line;
        }

        // Reescribir URI de audio, claves y otros recursos
        if (trimmed.startsWith("#")) {
          return line.replace(
            /URI="([^"]+)"/g,
            (match, uri) => {
              try {
                const absoluteUrl = new URL(uri, finalUrl).toString();

                return `URI="${saveUrl(absoluteUrl)}"`;
              } catch {
                return match;
              }
            }
          );
        }

        // Resolver segmentos y listas secundarias
        try {
          const absoluteUrl = new URL(trimmed, finalUrl).toString();

          return saveUrl(absoluteUrl);
        } catch (error) {
          console.error("Error resolviendo recurso:", trimmed);

          return line;
        }
      });

   

      return res.send(rewritten.join("\n"));
    }

    // Entregar segmentos de video y audio sin modificar
    if (response.body) {
      Readable.fromWeb(response.body).pipe(res);
    } else {
      res.end();
    }

  } catch (error) {
    console.error("Error en proxy:", error);

    if (!res.headersSent) {
      res.status(500).send("Error interno del proxy");
    } else {
      res.destroy();
    }
  }
});

app.listen(PORT,"0.0.0.0", () => {
});
