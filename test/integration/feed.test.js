const request = require('supertest');

const app = require('../../app');
const Video = require('../../models/videoModel');
const { makeChannel, makeVideos, makeVideo } = require('../helpers/seed');

describe('GET /api/v2/feed', () => {
  let channel;

  beforeEach(async () => {
    ({ channel } = await makeChannel({ name: 'Feed Channel' }));
    await makeVideos(channel, 25); // video-0 .. video-24, created in order
  });

  it('returns newest first, limited, with a cursor', async () => {
    const res = await request(app).get('/api/v2/feed?limit=10').expect(200);

    expect(res.body.data).toHaveLength(10);
    expect(res.body.data[0].title).toBe('video-24');
    expect(res.body.meta).toEqual({
      nextCursor: expect.any(String),
      hasMore: true,
      limit: 10,
    });
  });

  it('defaults to a limit of 20 rather than the whole collection', async () => {
    const res = await request(app).get('/api/v2/feed').expect(200);
    expect(res.body.data).toHaveLength(20);
  });

  it('clamps an absurd limit instead of returning everything', async () => {
    const res = await request(app).get('/api/v2/feed?limit=99999').expect(400);
    // Joi rejects above the ceiling; the client sees a clear error rather than silently
    // getting a different page size than it asked for.
    expect(res.body.error.code).toBe('INVALID_QUERY');
  });

  it('walks the whole collection with no duplicates and no gaps', async () => {
    const seen = [];
    let cursor;
    let guard = 0;

    do {
      const url = `/api/v2/feed?limit=7${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await request(app).get(url).expect(200);
      seen.push(...res.body.data.map((v) => v._id));
      cursor = res.body.meta.nextCursor;
      guard += 1;
    } while (cursor && guard < 20);

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  it('never repeats or skips when a video is uploaded mid-scroll', async () => {
    const first = await request(app).get('/api/v2/feed?limit=10').expect(200);

    // A new upload lands between the two page requests. With skip/limit this shifts
    // every row down by one, so page 2 repeats the last item of page 1 and one video is
    // never shown. A cursor on _id puts the intruder OUTSIDE the { $lt: cursor } window
    // entirely, so the reader walks a frozen prefix.
    await makeVideo(channel, { title: 'intruder' });

    const second = await request(app)
      .get(`/api/v2/feed?limit=10&cursor=${first.body.meta.nextCursor}`)
      .expect(200);

    const ids = [...first.body.data, ...second.body.data].map((v) => v._id);
    expect(new Set(ids).size).toBe(20);
    expect(second.body.data.map((v) => v.title)).not.toContain('intruder');
    expect(second.body.data[0].title).toBe('video-14');
  });

  it('omits the unbounded arrays and returns counts instead', async () => {
    const [video] = (await request(app).get('/api/v2/feed?limit=1').expect(200)).body.data;

    // These are the arrays that make GET /video/ heavy: they grow with every view, like
    // and comment, and the feed never reads them.
    expect(video.views.viewers).toBeUndefined();
    expect(video.likes.by).toBeUndefined();
    expect(video.comments).toBeUndefined();

    expect(video.views.count).toBe(0);
    expect(video.likes.count).toBe(0);
  });

  it('populates channel name and avatar', async () => {
    const [video] = (await request(app).get('/api/v2/feed?limit=1').expect(200)).body.data;
    expect(video.channel).toEqual(
      expect.objectContaining({ _id: expect.any(String), name: 'Feed Channel' })
    );
  });

  it('signals the end of the feed with hasMore false and a null cursor', async () => {
    const res = await request(app).get('/api/v2/feed?limit=50').expect(200);
    expect(res.body.data).toHaveLength(25);
    expect(res.body.meta.hasMore).toBe(false);
    expect(res.body.meta.nextCursor).toBeNull();
  });

  it('rejects a malformed cursor rather than silently restarting', async () => {
    const res = await request(app).get('/api/v2/feed?cursor=garbage').expect(400);
    expect(res.body.error.code).toBe('BAD_CURSOR');
  });

  describe('filtering', () => {
    it('filters by tag', async () => {
      await makeVideo(channel, { title: 'tagged', tags: ['music'] });

      const res = await request(app).get('/api/v2/feed?tag=music').expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].title).toBe('tagged');
    });

    it('filters by channel', async () => {
      const { channel: other } = await makeChannel({ name: 'Other' });
      await makeVideo(other, { title: 'elsewhere' });

      const res = await request(app)
        .get(`/api/v2/feed?channel=${other._id}&limit=50`)
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].title).toBe('elsewhere');
    });

    it('searches title and tags, case-insensitively', async () => {
      await makeVideo(channel, { title: 'Learning Guitar', tags: [] });
      await makeVideo(channel, { title: 'unrelated', tags: ['GUITAR'] });

      const res = await request(app).get('/api/v2/feed?q=guitar&limit=50').expect(200);

      expect(res.body.data.map((v) => v.title).sort()).toEqual(['Learning Guitar', 'unrelated']);
    });

    it('returns 200 with an empty array when a search matches nothing', async () => {
      const res = await request(app).get('/api/v2/feed?q=zzzznothing').expect(200);

      // The legacy GET /video/search/:query 404s here, which the client cannot tell
      // apart from a network failure. A search that found nothing is a successful
      // search.
      expect(res.body.data).toEqual([]);
      expect(res.body.meta.hasMore).toBe(false);
    });

    it('treats a search string as text, not as a regex', async () => {
      await makeVideo(channel, { title: 'plain title' });

      // An unescaped '.*' would match everything; '(' alone would throw and 500.
      const dotStar = await request(app).get('/api/v2/feed?q=.*&limit=50').expect(200);
      expect(dotStar.body.data).toHaveLength(0);

      await request(app).get('/api/v2/feed?q=%28&limit=50').expect(200);
    });

    it('paginates within a filtered result set', async () => {
      await makeVideos(channel, 5, { titlePrefix: 'rock' });
      await Video.updateMany({ title: /^rock-/ }, { $set: { tags: ['rock'] } });

      const first = await request(app).get('/api/v2/feed?tag=rock&limit=2').expect(200);
      expect(first.body.data).toHaveLength(2);
      expect(first.body.meta.hasMore).toBe(true);

      const second = await request(app)
        .get(`/api/v2/feed?tag=rock&limit=2&cursor=${first.body.meta.nextCursor}`)
        .expect(200);

      const ids = [...first.body.data, ...second.body.data].map((v) => v._id);
      expect(new Set(ids).size).toBe(4);
    });
  });

  it('leaves GET /video/ completely alone', async () => {
    const res = await request(app).get('/video/').expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(await Video.countDocuments());
    // Still the full document, arrays and all.
    expect(res.body[0].comments).toBeDefined();
  });
});
