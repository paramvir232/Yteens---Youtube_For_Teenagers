require('dotenv').config();
const axios = require('axios');

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YOUTUBE_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';

async function fetchYouTubeVideos(query = 'math', maxResults = 1) {
  try {
    const res = await axios.get(YOUTUBE_SEARCH_URL, {
      params: {
        key: YOUTUBE_API_KEY,
        q: query,
        part: 'snippet',
        type: 'video',
        maxResults
      }
    });

    const videos = res.data.items.map(item => ({
      title: item.snippet.title,
      description: item.snippet.description,
      link: `https://www.youtube.com/watch?v=${item.id.videoId}`
    }));

    return videos;

  } catch (err) {
    console.error('Error fetching videos:', err.message);
    return [];
  }
}

async function fetchYouTubeVideosByTopics(topicMap = { 'math': 3, 'tech': 2 }) {
  const entries = Object.entries(topicMap); // [['math', 3], ['tech', 2]]

  const allVideos = await Promise.all(
    entries.map(([topic, count]) => fetchYouTubeVideos(topic, count))
  );

  return allVideos.flat();
}

module.exports = fetchYouTubeVideosByTopics;


