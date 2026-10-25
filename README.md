# cam1-playlist

Playlist M3U das salas ao vivo do Cam4 (cam4.com), gerada pelo script `cam4_update.py`.

## Link direto (raw)

```
https://raw.githubusercontent.com/leandrorsnrz/cam1-playlist/main/cam1.m3u
```

Use esse link em players compatíveis com M3U/HLS (VLC, TiviMate, OTT Navigator, etc.).

## Observações

- As URLs de stream são dinâmicas: quando uma transmissão reinicia, a URL muda.
  Reabra/atualize a playlist no player para renovar.
- O arquivo `cam1.m3u` é regenerado periodicamente com as salas ao vivo no momento
  da atualização (nome, snapshot, grupo e contagem de espectadores).
- Grupos: `Cam4 Female`, `Cam4 Male`, `Cam4 Trans`.
