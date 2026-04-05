const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Setup Database
const db = new sqlite3.Database('./database.sqlite');

db.serialize(() => {
    // Users Table (Role: 'admin' or 'vendor')
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT
    )`);

    // Products Table
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        category TEXT,
        description TEXT,
        price REAL,
        vendor_id INTEGER,
        FOREIGN KEY(vendor_id) REFERENCES users(id)
    )`);

    // Create default admin if it doesn't exist (Username: admin, Password: adminpassword)
    db.get("SELECT * FROM users WHERE role = 'admin'", (err, row) => {
        if (!row) {
            db.run("INSERT INTO users (username, password, role) VALUES ('admin', 'adminpassword', 'admin')");
        }
    });
});

// Middleware
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'studycloud-secret-key',
    resave: false,
    saveUninitialized: false
}));

// Categories List
const CATEGORIES = [
    'SAT', 'PSAT', 'AP', 'DSAT', 'LSAT', 
    'Honorlock', 'Lockdown Browser', 'Proctorio', 
    'Pearson VUE', 'ExamSoft', 'Competitions'
];

// --- ROUTES ---

// 1. Home / Marketplace
app.get('/', (req, res) => {
    const searchQuery = req.query.q || '';
    const categoryFilter = req.query.category || '';

    let query = "SELECT products.*, users.username as vendor_name FROM products JOIN users ON products.vendor_id = users.id WHERE 1=1";
    let params = [];

    if (searchQuery) {
        query += " AND (title LIKE ? OR description LIKE ?)";
        params.push(`%${searchQuery}%`, `%${searchQuery}%`);
    }
    if (categoryFilter && categoryFilter !== 'All') {
        query += " AND category = ?";
        params.push(categoryFilter);
    }

    db.all(query, params, (err, rows) => {
        res.render('index', { 
            products: rows || [], 
            searchQuery, 
            categoryFilter: categoryFilter || 'All',
            categories: CATEGORIES,
            user: req.session.user 
        });
    });
});

// 2. Auth Routes
app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, password], (err, user) => {
        if (user) {
            req.session.user = user;
            if (user.role === 'admin') return res.redirect('/admin');
            return res.redirect('/dashboard');
        }
        res.render('login', { error: 'Invalid credentials' });
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// 3. Admin Route (Only Admin can create users)
app.get('/admin', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login');
    
    db.all("SELECT id, username, role FROM users WHERE role = 'vendor'", (err, users) => {
        res.render('admin', { users: users || [], user: req.session.user });
    });
});

app.post('/admin/create-user', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login');
    const { username, password } = req.body;
    
    db.run("INSERT INTO users (username, password, role) VALUES (?, ?, 'vendor')", [username, password], (err) => {
        res.redirect('/admin');
    });
});

// 4. Vendor Dashboard (Only Users can post products)
app.get('/dashboard', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'vendor') return res.redirect('/login');
    res.render('dashboard', { user: req.session.user, categories: CATEGORIES });
});

app.post('/dashboard/add-product', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'vendor') return res.redirect('/login');
    const { title, category, description, price } = req.body;
    const vendor_id = req.session.user.id;

    db.run("INSERT INTO products (title, category, description, price, vendor_id) VALUES (?, ?, ?, ?, ?)", 
    [title, category, description, price, vendor_id], (err) => {
        res.redirect('/');
    });
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
