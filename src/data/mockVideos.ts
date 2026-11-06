export interface Video {
  id: string;
  title: string;
  thumbnail: string;
  duration: string;
  views: string;
  likes: number;
  category: string;
  tags: string[];
  videoUrl: string;
  creator: string;
  creatorAvatar: string;
  uploadedAt: string;
  description: string;
}

const thumbnails = [
  "https://images.unsplash.com/photo-1535268647677-300dbf3d78d1?w=640&q=80",
  "https://images.unsplash.com/photo-1518621736915-f3b1c41bfd00?w=640&q=80",
  "https://images.unsplash.com/photo-1529543544282-ea669407fca3?w=640&q=80",
  "https://images.unsplash.com/photo-1540553016722-983e48a2cd10?w=640&q=80",
  "https://images.unsplash.com/photo-1501854140801-50d01698950b?w=640&q=80",
  "https://images.unsplash.com/photo-1476842634003-7dcca8f832de?w=640&q=80",
  "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=640&q=80",
  "https://images.unsplash.com/photo-1519125323398-675f0ddb6308?w=640&q=80",
  "https://images.unsplash.com/photo-1508214751196-bcfd4ca60f91?w=640&q=80",
  "https://images.unsplash.com/photo-1522202176988-66273c2fd55f?w=640&q=80",
  "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=640&q=80",
  "https://images.unsplash.com/photo-1521119989659-a83eee488004?w=640&q=80",
];

const categories = ["Featured", "New", "Trending", "Popular", "Premium", "Exclusive"];
const creators = [
  { name: "Luna Star", avatar: "https://i.pravatar.cc/40?img=1" },
  { name: "Mia Rose", avatar: "https://i.pravatar.cc/40?img=2" },
  { name: "Aria Gold", avatar: "https://i.pravatar.cc/40?img=3" },
  { name: "Zara Night", avatar: "https://i.pravatar.cc/40?img=4" },
  { name: "Bella Vega", avatar: "https://i.pravatar.cc/40?img=5" },
  { name: "Nova Bliss", avatar: "https://i.pravatar.cc/40?img=6" },
];

const videoTitles = [
  "Midnight Desire – Full Scene",
  "Golden Hour Exclusive",
  "Private Collection Vol.3",
  "Late Night Sessions",
  "Velvet Dreams Premium",
  "Secret Garden Special",
  "Diamond Edition – Uncensored",
  "Luxury Escape Episode 5",
  "After Dark Premium",
  "Crimson Rose Full Video",
  "Sapphire Nights Collection",
  "Obsidian Fantasy Premium",
  "Crystal Clear HD Special",
  "Platinum Series Vol.7",
  "Ember Glow Exclusive",
  "Shadow Play Premium",
  "Neon Lights Special Edition",
  "Ivory & Gold Full Scene",
  "Midnight Rendezvous",
  "Scarlet Veil Collection",
];

const durations = ["12:34", "23:11", "8:45", "45:00", "15:22", "31:07", "19:58", "27:43", "10:15", "38:52"];
const views = ["1.2M", "890K", "3.4M", "567K", "2.1M", "445K", "1.8M", "234K", "5.6M", "789K"];

export const generateMockVideos = (count: number, startId = 0): Video[] => {
  return Array.from({ length: count }, (_, i) => {
    const idx = (startId + i) % videoTitles.length;
    const creator = creators[idx % creators.length];
    return {
      id: `video-${startId + i}`,
      title: videoTitles[idx],
      thumbnail: `${thumbnails[idx % thumbnails.length]}&sig=${startId + i}`,
      duration: durations[idx % durations.length],
      views: views[idx % views.length],
      likes: Math.floor(Math.random() * 50000) + 1000,
      category: categories[idx % categories.length],
      tags: ["exclusive", "premium", "hd", "full scene"].slice(0, (idx % 3) + 2),
      videoUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
      creator: creator.name,
      creatorAvatar: creator.avatar,
      uploadedAt: `${Math.floor(Math.random() * 30) + 1} days ago`,
      description: "Premium exclusive content. Available for all verified members.",
    };
  });
};

export const INITIAL_VIDEOS = generateMockVideos(12, 0);
