# Cinema caption translation and spoken captions

Cinema translates existing transcript lines. The host must enable **Store captions and transcript** and **Allow translated subtitles** in the Captions panel. Each viewer then chooses a subtitle language in the player. The same controls work in watch rooms and discussion broadcasts. Translation does not create captions from a movie soundtrack: the host can import WebVTT for a file, or members can caption their microphones in browsers that support speech recognition. A YouTube video's own captions remain under YouTube's controls.

**Audio on** reads the visible caption through the viewer's browser speech synthesis. It is optional, device dependent, and does not replace or translate the underlying media audio. Some languages have no suitable installed voice. Headphones may help when the original media and spoken caption overlap.

The translation API checks room membership and the host's translation setting. Only the selected source line goes to the configured AI service. A stored translation is shared across viewers of that room, with a database claim to prevent concurrent viewers from triggering duplicate model calls. Translation rows expire with their source transcript; clearing or purging the transcript removes them. When AI is unavailable, the original caption remains visible. The rate limit is 30 translation requests per member per minute.

The application applies the schema update automatically. `sql/047_cinema_caption_translations.sql` is provided for manual migration of an existing database; run it once, as its `ALTER TABLE` statement is intentionally non-repeatable.
