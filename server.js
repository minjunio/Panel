const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ====================== CONFIG ======================
const ADMIN_PASSWORD = 'minjunseoyeon2026'; // CHANGE THIS PASSWORD in production!
const SESSION_SECRET = 'minjun-korea-blog-secret-2026';

// ====================== MIDDLEWARE ======================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false,
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

// ====================== DATA HANDLING (Posts) ======================
const dataDir = path.join(__dirname, 'data');
const postsPath = path.join(dataDir, 'posts.json');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let posts = [];
function loadPosts() {
  try {
    if (fs.existsSync(postsPath)) {
      const data = fs.readFileSync(postsPath, 'utf8');
      posts = JSON.parse(data);
    } else {
      posts = [];
      savePosts();
    }
  } catch (err) {
    console.error('Error loading posts:', err);
    posts = [];
  }
}

function savePosts() {
  try {
    fs.writeFileSync(postsPath, JSON.stringify(posts, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving posts:', err);
  }
}

loadPosts();

// ====================== AUTH MIDDLEWARE ======================
function requireLogin(req, res, next) {
  if (req.session && req.session.loggedIn) {
    return next();
  }
  res.redirect('/admin');
}

// ====================== ROUTES ======================

// PUBLIC HOME PAGE
app.get('/', (req, res) => {
  const sortedPosts = [...posts].sort((a, b) => b.id - a.id);
  res.render('index', { 
    posts: sortedPosts,
    visitorStats: {
      weekly: 5284,
      lifetime: 1342891
    }
  });
});

// ADMIN ROUTES (unchanged)
app.get('/admin', (req, res) => {
  const isLoggedIn = req.session && req.session.loggedIn;
  
  if (isLoggedIn) {
    const sortedPosts = [...posts].sort((a, b) => b.id - a.id);
    res.render('admin', { 
      loggedIn: true, 
      posts: sortedPosts,
      success: req.query.success || null,
      error: req.query.error || null
    });
  } else {
    res.render('admin', { 
      loggedIn: false, 
      posts: [],
      success: null,
      error: null
    });
  }
});

app.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    req.session.loggedIn = true;
    req.session.save(() => {
      res.redirect('/admin?success=Welcome back, Minjun!');
    });
  } else {
    res.redirect('/admin?error=Incorrect password. Please try again.');
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin');
  });
});

app.post('/admin/posts', requireLogin, (req, res) => {
  try {
    const { title, content, imageUrl, category } = req.body;
    if (!title || !content) {
      return res.redirect('/admin?error=Title and content are required.');
    }

    const newPost = {
      id: Date.now(),
      title: title.trim(),
      content: content.trim(),
      imageUrl: imageUrl && imageUrl.trim() ? imageUrl.trim() : 'https://picsum.photos/id/1018/1200/630',
      category: category || 'Personal',
      date: new Date().toISOString().split('T')[0],
      excerpt: content.trim().substring(0, 140) + (content.length > 140 ? '...' : '')
    };

    posts.unshift(newPost);
    savePosts();
    res.redirect('/admin?success=Blog post published successfully! 🎉');
  } catch (err) {
    console.error(err);
    res.redirect('/admin?error=Failed to create post. Please try again.');
  }
});

app.post('/admin/posts/:id', requireLogin, (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const { title, content, imageUrl, category } = req.body;
    const postIndex = posts.findIndex(p => p.id === postId);
    if (postIndex === -1) return res.redirect('/admin?error=Post not found.');

    posts[postIndex].title = title.trim();
    posts[postIndex].content = content.trim();
    posts[postIndex].imageUrl = imageUrl && imageUrl.trim() ? imageUrl.trim() : posts[postIndex].imageUrl;
    posts[postIndex].category = category || posts[postIndex].category;
    posts[postIndex].excerpt = content.trim().substring(0, 140) + (content.length > 140 ? '...' : '');

    savePosts();
    res.redirect('/admin?success=Post updated successfully!');
  } catch (err) {
    res.redirect('/admin?error=Failed to update post.');
  }
});

app.delete('/admin/posts/:id', requireLogin, (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    posts = posts.filter(p => p.id !== postId);
    savePosts();
    res.json({ success: true, message: 'Post deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete post' });
  }
});

app.get('/api/posts', (req, res) => {
  const sortedPosts = [...posts].sort((a, b) => b.id - a.id);
  res.json(sortedPosts);
});

// ====================== NEW DATA: KOREA CITIES + BUSAN NEWS ======================

const koreanCities = [
  {
    name: "Seoul",
    description: "The vibrant capital blending ancient palaces with futuristic skyscrapers.",
    spots: [
      { name: "Gyeongbokgung Palace", rating: 4.8, price: "Free / ₩3,000", image: "https://picsum.photos/id/1015/600/400", description: "The largest and most beautiful of Seoul's five grand palaces.", mapQuery: "Gyeongbokgung Palace Seoul" },
      { name: "Namsan Seoul Tower", rating: 4.6, price: "₩16,000", image: "https://picsum.photos/id/1005/600/400", description: "Iconic tower with panoramic views of the entire city.", mapQuery: "N Seoul Tower Seoul" },
      { name: "Myeongdong Shopping Street", rating: 4.4, price: "Free", image: "https://picsum.photos/id/106/600/400", description: "Korea's most famous shopping and street food district.", mapQuery: "Myeongdong Seoul" }
    ]
  },
  {
    name: "Busan",
    description: "Korea's second city — stunning beaches, fresh seafood, and mountain temples by the sea.",
    spots: [
      { name: "Haedong Yonggungsa Temple", rating: 4.7, price: "Free", image: "https://picsum.photos/id/1016/600/400", description: "Rare seaside Buddhist temple with breathtaking ocean views.", mapQuery: "Haedong Yonggungsa Temple Busan" },
      { name: "Haeundae Beach", rating: 4.5, price: "Free", image: "https://picsum.photos/id/1009/600/400", description: "Busan's most famous beach with white sand and vibrant nightlife.", mapQuery: "Haeundae Beach Busan" },
      { name: "Gamcheon Culture Village", rating: 4.8, price: "Free", image: "https://picsum.photos/id/160/600/400", description: "Colorful hillside village known as the 'Machu Picchu of Busan'.", mapQuery: "Gamcheon Culture Village Busan" }
    ]
  },
  {
    name: "Jeju Island",
    description: "Korea's volcanic paradise famous for black pork, tangerines, and stunning nature.",
    spots: [
      { name: "Seongsan Ilchulbong", rating: 4.9, price: "₩5,000", image: "https://picsum.photos/id/251/600/400", description: "Dramatic volcanic crater rising from the sea — sunrise hotspot.", mapQuery: "Seongsan Ilchulbong Jeju" },
      { name: "Manjanggul Lava Tube", rating: 4.6, price: "₩4,000", image: "https://picsum.photos/id/201/600/400", description: "One of the world's longest lava tubes with incredible formations.", mapQuery: "Manjanggul Cave Jeju" },
      { name: "Jeju Folk Village", rating: 4.3, price: "₩12,000", image: "https://picsum.photos/id/29/600/400", description: "Traditional thatched-roof houses showing old Jeju lifestyle.", mapQuery: "Jeju Folk Village" }
    ]
  },
  {
    name: "Incheon",
    description: "Home to Korea's largest international airport and beautiful islands.",
    spots: [
      { name: "Incheon Chinatown", rating: 4.2, price: "Free", image: "https://picsum.photos/id/133/600/400", description: "Historic Chinese district with great food and colorful streets.", mapQuery: "Incheon Chinatown" },
      { name: "Songdo Central Park", rating: 4.5, price: "Free", image: "https://picsum.photos/id/180/600/400", description: "Modern eco-park with beautiful canals and city views.", mapQuery: "Songdo Central Park Incheon" }
    ]
  },
  {
    name: "Daegu",
    description: "A major cultural and industrial hub in southeastern Korea.",
    spots: [
      { name: "Dongseongno Street", rating: 4.4, price: "Free", image: "https://picsum.photos/id/251/600/400", description: "Daegu's main shopping and nightlife street.", mapQuery: "Dongseongno Daegu" },
      { name: "Apsan Park", rating: 4.7, price: "Free", image: "https://picsum.photos/id/160/600/400", description: "Mountain park with cable car and great hiking trails.", mapQuery: "Apsan Park Daegu" }
    ]
  },
  {
    name: "Gwangju",
    description: "Known for its rich history, art scene, and delicious cuisine.",
    spots: [
      { name: "Gwangju Biennale", rating: 4.5, price: "₩10,000", image: "https://picsum.photos/id/201/600/400", description: "Asia's oldest contemporary art biennale.", mapQuery: "Gwangju Biennale" },
      { name: "Mudeungsan National Park", rating: 4.8, price: "Free", image: "https://picsum.photos/id/29/600/400", description: "Beautiful mountain with hiking trails and cable car.", mapQuery: "Mudeungsan National Park" }
    ]
  }
];

let busanNews = [
  {
    id: 1,
    title: "Haeundae Beach prepares for summer festival season",
    summary: "Busan city officials announced a series of night markets and fireworks shows starting next week.",
    date: "2026-07-25",
    category: "Events"
  },
  {
    id: 2,
    title: "New direct flight from Busan to Tokyo announced",
    summary: "Air Busan will launch daily flights to Haneda Airport starting September.",
    date: "2026-07-24",
    category: "Travel"
  },
  {
    id: 3,
    title: "Gamcheon Village sees record visitors this month",
    summary: "Over 120,000 tourists visited the colorful hillside village in July alone.",
    date: "2026-07-22",
    category: "Tourism"
  }
];

// ====================== NEW API ROUTES ======================

app.get('/api/cities', (req, res) => {
  res.json(koreanCities);
});

app.get('/api/cities/:cityName/spots', (req, res) => {
  const city = koreanCities.find(c => c.name.toLowerCase() === req.params.cityName.toLowerCase());
  if (!city) {
    return res.status(404).json({ error: "City not found" });
  }
  res.json(city);
});

app.get('/api/busan-news', (req, res) => {
  res.json(busanNews.sort((a, b) => b.id - a.id));
});

app.post('/api/busan-news/refresh', (req, res) => {
  const newNews = {
    id: Date.now(),
    title: "Breaking: Busan Metro Line 3 extension approved",
    summary: "The city government confirmed funding for extending Line 3 to Haeundae by 2029.",
    date: new Date().toISOString().split('T')[0],
    category: "Infrastructure"
  };
  busanNews.unshift(newNews);
  if (busanNews.length > 6) busanNews.pop();
  res.json({ success: true, news: busanNews });
});

// ====================== ERROR HANDLING ======================
app.use((req, res) => {
  res.status(404).send(`
    <div style="text-align:center; padding: 80px 20px; font-family: system-ui;">
      <h1 style="font-size: 4rem; margin-bottom: 1rem;">404</h1>
      <p style="font-size: 1.25rem; color: #64748b;">Page not found. Let's get you back to the blog.</p>
      <a href="/" style="display: inline-block; margin-top: 2rem; padding: 12px 28px; background: #0f172a; color: white; text-decoration: none; border-radius: 9999px;">← Return Home</a>
    </div>
  `);
});

// ====================== START SERVER ======================
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  ✈️  Minjun Seoyeon Blog is running!                        ║
║  🌍  http://localhost:${PORT}                               ║
║  📝  Admin panel: http://localhost:${PORT}/admin            ║
║  🗺️  Korea Cities Explorer + Live Busan News added          ║
║  🔑  Default password: minjunseoyeon2026 (change it!)       ║
╚════════════════════════════════════════════════════════════╝
  `);
});