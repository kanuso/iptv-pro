
import { useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import {
  Tv, Search, Heart, Radio, 
  RefreshCw, Maximize, Menu, Signal
} from "lucide-react";
import "./App.css";

type Channel = {
  id: string;
  name: string;
  url: string;
  category: string;
  type?: "hls" | "embed";
};

const nationalChannels: Channel[] = [
  {
    id: "canal25",
    name: "Canal 25",
    url: "https://stream.digitalgt.com:3799/live/canal25srlive.m3u8",
    category: "Nacionales",
  },
  {
    id: "canal7",
    name: "Canal 7",
    url: "https://ddycmnicl95kp.cloudfront.net/live/hm8maie2jnn2/master.m3u8",
    category: "Nacionales",
  },
  {
    id: "canal3",
    name: "Canal 3",
    url: "https://ddycmnicl95kp.cloudfront.net/live/i8bocdjcqa5r/master.m3u8",
    category: "Nacionales",
  },
    {
    id: "TVAzteca",
    name: "TVAzteca",
    url: "https://guastream.com:3996/stream/play.m3u8",
    category: "Nacionales",
  },
  {
    id: "guatevision",
    name: "Guatevisión",
    url: "https://mdstrm.com/live-stream/69f8df22a762c9b1ab3eabca?autoplay=false&player=69f948387c9694d4da443389",
    category: "Nacionales",
    type: "embed",
  },
];

function detectCategory(name: string): string {
  const n = name.toLowerCase();

  if (/noticias|news|actualidad|euronews|cnn/.test(n))
    return "Noticias";

  if (/cine|pel[ií]cula|thriller|horror|western|runtime|action/.test(n))
    return "Cine";

  if (/dragon ball|anime|piece|conan|yu-gi|naruto|inazuma/.test(n))
    return "Anime";

  if (/kids|junior|infantil|bob esponja|barbie|heidi|winx|pitufos|rugrats/.test(n))
    return "Infantil";

  if (/fifa|f[uú]tbol|sport|ufc|rally|motor|bar[cç]a|realmadrid|darts/.test(n))
    return "Deportes";

  if (/mtv|reality|catfish|geordies|teen mom/.test(n))
    return "Entretenimiento";

  if (/historia|documental|forenses|detectives|crimen|fbi|investigaci[oó]n/.test(n))
    return "Documentales";

  if (/pluto tv|series|serie|drama|comedia|midsomer/.test(n))
    return "Series";

  return "Otros";
}

function parseM3U(content: string): Channel[] {
  const lines = content.split(/\r?\n/);
  const result: Channel[] = [];
  let currentName = "";
  let currentId = "";

  for (const raw of lines) {
    const line = raw.trim();

    if (line.startsWith("#EXTINF:")) {
      const comma = line.lastIndexOf(",");
      currentName = comma >= 0
        ? line.substring(comma + 1).trim()
        : "Canal sin nombre";

      currentId =
        line.match(/tvg-id="([^"]*)"/)?.[1] || "";
    } else if (
      line &&
      !line.startsWith("#") &&
      currentName &&
      /^https?:\/\//i.test(line)
    ) {
      result.push({
        id: currentId || `m3u-${result.length}`,
        name: currentName,
        url: line,
        category: detectCategory(currentName),
      });

      currentName = "";
      currentId = "";
    }
  }

  return result;
}



async function getStreamUrl(url: string): Promise<string> {
  const parsed = new URL(url);

  // Los canales HTTPS públicos pueden reproducirse directamente,
  // excepto los que necesitan pasar por el proxy.
  const needsProxy =
    parsed.protocol === "http:" ||
    parsed.hostname === "jmp2.uk";

  if (!needsProxy) {
    return url;
  }

  const API_URL = import.meta.env.VITE_API_URL?.replace(/\/+$/, "");

  if (!API_URL) {
    throw new Error("Falta configurar VITE_API_URL");
  }

  const response = await fetch(
    `${API_URL}/create-proxy?url=${encodeURIComponent(url)}`
  );

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Error creando proxy (${response.status}): ${message}`);
  }

  const data: { url: string } = await response.json();

  if (!data.url) {
    throw new Error("El backend no devolvió una URL del proxy");
  }

  const proxyUrl = new URL(data.url, API_URL);

  if (proxyUrl.protocol !== "https:") {
    throw new Error("El proxy debe devolver una dirección HTTPS");
  }

  return proxyUrl.toString();
}

function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  const [channels, setChannels] = useState<Channel[]>(nationalChannels);
  const [selected, setSelected] = useState<Channel>(nationalChannels[0]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("Todos");
  const [favorites, setFavorites] = useState<string[]>([]);
  const [status, setStatus] = useState("Conectando...");
  const [reload, setReload] = useState(0);

  // Cargar lista M3U
  useEffect(() => {
    fetch("/canales.m3u")
      .then(response => {
        if (!response.ok) throw new Error("Lista M3U no encontrada");
        return response.text();
      })
      .then(content => {
        const parsed = parseM3U(content);

        setChannels([
          ...nationalChannels,
          ...parsed.filter(
            item => !nationalChannels.some(c => c.url === item.url)
          ),
        ]);
      })
      .catch(error => {
        console.error(error);
        setStatus("Lista M3U no disponible");
      });
  }, []);


  // Reproducir canal seleccionado
  useEffect(() => {
    const video = videoRef.current;

    hlsRef.current?.destroy();
    hlsRef.current = null;

    if (!video || selected.type === "embed") {
      if (selected.type === "embed") {
        setStatus("Abriendo reproductor externo");
      }
      return;
    }

    let cancelled = false;
    let currentHls: Hls | null = null;

    video.pause();
    video.removeAttribute("src");
    video.load();

    setStatus("Conectando...");

    const startPlayer = async () => {
      try {
        // Esperamos a que el proxy nos devuelva la URL real
        const streamUrl = await getStreamUrl(selected.url);

        if (cancelled) return;

        if (Hls.isSupported()) {
          const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: true,
            backBufferLength: 30,
            maxBufferLength: 30,
          });

          currentHls = hls;
          hlsRef.current = hls;

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (cancelled) return;

            setStatus("En vivo");

            video.play().catch(() => {
              setStatus("Presiona reproducir");
            });
          });

          hls.on(Hls.Events.ERROR, (_event, data) => {
            console.groupEnd();

            if (data.fatal) {
              setStatus(`Error: ${data.details}`);
              hls.destroy();

              if (hlsRef.current === hls) {
                hlsRef.current = null;
              }
            }
          });

          hls.loadSource(streamUrl);
          hls.attachMedia(video);

        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = streamUrl;

          video.onloadedmetadata = () => {
            if (cancelled) return;

            setStatus("En vivo");

            video.play().catch(() => {
              setStatus("Presiona reproducir");
            });
          };

          video.onerror = () => {
            setStatus("Error al cargar el canal");
          };

        } else {
          setStatus("Navegador no compatible");
        }

      } catch (error) {
        if (cancelled) return;

        console.error("Error iniciando reproductor:", error);
        setStatus("Error al conectar con el servidor");
      }
    };

    startPlayer();

    return () => {
      cancelled = true;

      currentHls?.destroy();

      if (hlsRef.current === currentHls) {
        hlsRef.current = null;
      }
    };
  }, [selected, reload]);


  const categories = useMemo(
    () => ["Todos", "Nacionales", ...new Set(
      channels
        .map(channel => channel.category)
        .filter(c => c !== "Nacionales")
    ), "Favoritos"],
    [channels]
  );

  const filteredChannels = useMemo(() => {
    return channels.filter(channel => {
      const matchesSearch = channel.name
        .toLowerCase()
        .includes(search.toLowerCase());

      const matchesCategory =
        category === "Todos" ||
        channel.category === category ||
        (category === "Favoritos" && favorites.includes(channel.id));

      return matchesSearch && matchesCategory;
    });
  }, [channels, search, category, favorites]);

  const toggleFavorite = (id: string) => {
    setFavorites(prev =>
      prev.includes(id)
        ? prev.filter(item => item !== id)
        : [...prev, id]
    );
  };

  const fullscreen = () => {
    videoRef.current?.requestFullscreen();
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="logo">
          <Radio size={28} />
          <span>IPTV <b>PRO</b></span>
        </div>

        <div className="top-info">
          <span className="live-dot" />
          TELEVISIÓN EN VIVO
          <span className="channel-count">
            {channels.length} canales
          </span>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar-title">
            <Menu size={18} />
            EXPLORAR
          </div>

          {categories.map(cat => (
            <button
              key={cat}
              className={`category ${category === cat ? "active" : ""}`}
              onClick={() => setCategory(cat)}
            >
              {cat === "Favoritos" ? <Heart size={17} /> :
                cat === "Todos" ? <Tv size={17} /> :
                <Radio size={17} />}
              {cat}
            </button>
          ))}
        </aside>

        <main className="main">
          <div className="heading">
            <div>
              <span className="eyebrow">TU TELEVISIÓN DIGITAL</span>
              <h1>{selected.name}</h1>
              <p>Disfruta de tus canales favoritos.</p>
            </div>

            <div className="live-status">
              <Signal size={17} />
              {status}
            </div>
          </div>

          <section className="player-container">
            {selected.type === "embed" ? (
              <iframe
                key={selected.id}
                src={selected.url}
                title={selected.name}
                allow="autoplay; encrypted-media; picture-in-picture"
                allowFullScreen
              />
            ) : (
              <video
                ref={videoRef}
                controls
                playsInline
                autoPlay
              />
            )}

            <div className="player-label">
              <span className="live-dot" /> EN VIVO
            </div>
          </section>

          <div className="player-actions">
            <div className="playing">
              <div className="channel-avatar">
                <Tv size={23} />
              </div>
              <div>
                <strong>{selected.name}</strong>
                <small>{selected.category}</small>
              </div>
            </div>

            <div className="buttons">
              <button onClick={() => setReload(n => n + 1)}>
                <RefreshCw size={17} /> Recargar
              </button>
              <button onClick={fullscreen}>
                <Maximize size={17} /> Pantalla completa
              </button>
              <button onClick={() => toggleFavorite(selected.id)}>
                <Heart
                  size={17}
                  fill={favorites.includes(selected.id) ? "currentColor" : "none"}
                />
              </button>
            </div>
          </div>

          <section className="channels-section">
            <div className="section-heading">
              <div>
                <h2>Canales disponibles</h2>
                <p>{filteredChannels.length} canales encontrados</p>
              </div>

              <div className="search-box">
                <Search size={18} />
                <input
                  placeholder="Buscar canal..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
            </div>

            <div className="channel-grid">
              {filteredChannels.map(channel => (
                <div
                  key={channel.id}
                  className={`channel-card ${
                    selected.id === channel.id ? "selected" : ""
                  }`}
                  onClick={() => setSelected(channel)}
                >
                  <div className="card-icon">
                    <Tv size={26} />
                  </div>

                  <div className="card-info">
                    <strong>{channel.name}</strong>
                    <small>{channel.category}</small>
                  </div>

                  <button
                    className="favorite-btn"
                    onClick={e => {
                      e.stopPropagation();
                      toggleFavorite(channel.id);
                    }}
                    aria-label="Agregar a favoritos"
                  >
                    <Heart
                      size={17}
                      fill={favorites.includes(channel.id) ? "currentColor" : "none"}
                    />
                  </button>
                </div>
              ))}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

export default App;
