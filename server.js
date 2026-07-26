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
    secure: false, // set to true if using HTTPS in production
    maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
  }
}));

// ====================== DATA HANDLING ======================
const dataDir = path.join(__dirname, 'data');
const postsPath = path.join(dataDir, 'posts.json');

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Load posts from file or create with seed
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

// Initial load
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

// ADMIN LOGIN PAGE + DASHBOARD
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

// Handle login
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

// Logout
app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin');
  });
});

// CREATE new post (admin only)
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

// UPDATE existing post
app.post('/admin/posts/:id', requireLogin, (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const { title, content, imageUrl, category } = req.body;

    const postIndex = posts.findIndex(p => p.id === postId);
    if (postIndex === -1) {
      return res.redirect('/admin?error=Post not found.');
    }

    posts[postIndex].title = title.trim();
    posts[postIndex].content = content.trim();
    posts[postIndex].imageUrl = imageUrl && imageUrl.trim() ? imageUrl.trim() : posts[postIndex].imageUrl;
    posts[postIndex].category = category || posts[postIndex].category;
    posts[postIndex].excerpt = content.trim().substring(0, 140) + (content.length > 140 ? '...' : '');

    savePosts();

    res.redirect('/admin?success=Post updated successfully!');
  } catch (err) {
    console.error(err);
    res.redirect('/admin?error=Failed to update post.');
  }
});

// DELETE post
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

// API endpoint to get all posts
app.get('/api/posts', (req, res) => {
  const sortedPosts = [...posts].sort((a, b) => b.id - a.id);
  res.json(sortedPosts);
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
║  🔑  Default password: minjunseoyeon2026 (change it!)       ║
╚════════════════════════════════════════════════════════════╝
  `);
});