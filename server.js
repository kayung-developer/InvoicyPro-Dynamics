// server.js
// To run this:
// 1. Create a file named .env in the same directory as server.js
// 2. Add your environment variables to .env (see example .env content provided separately)
// 3. Install dependencies: npm install express cors body-parser jsonwebtoken bcryptjs express-validator uuid dotenv
// 4. Run: node server.js
// The API will be available at http://localhost:PORT/api (PORT is defined in .env)

require('dotenv').config(); // Load environment variables from .env file

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { body, validationResult, param } = require('express-validator');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 4000; // Fallback if PORT is not in .env
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
    console.error("FATAL ERROR: JWT_SECRET is not defined in the environment variables. Please check your .env file.");
    process.exit(1); // Exit if JWT_SECRET is not set
}

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// In-memory "Database"
let db = {
    users: [], // { id, name, email, passwordHash, roles: ['user' or 'admin'], createdAt, updatedAt }
    settings: {}, // { userId: { companyName, companyAddress, companyLogoUrl, defaultCurrency, defaultTaxRate, invoiceTemplate } }
    clients: [], // { id, userId, name, email, phone, address, notes, createdAt, updatedAt }
    invoices: [], // { id, userId, clientId, client_name (denormalized), invoice_number, invoice_date, due_date, items: [{description, quantity, unit_price, tax_rate}], total_amount, status, notes, currency, global_tax_rate, is_recurring, recurrence_frequency, recurrence_interval, recurrence_end_date, createdAt, updatedAt }
    payments: [], // { id, invoiceId, userId, amount, payment_date, payment_method, notes, createdAt }
};

// --- Helper Functions ---
const generateInvoiceNumber = () => `INV-${new Date().getFullYear()}-${String(db.invoices.length + 1).padStart(5, '0')}`;

// --- Auth Middleware ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (token == null) return res.status(401).json({ message: 'Authentication token required.' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: 'Invalid or expired token.' });
        req.user = user; // Add user payload to request
        next();
    });
};

// --- Role Middleware ---
const authorizeRole = (roles) => {
    return (req, res, next) => {
        if (!req.user || !req.user.roles) {
            return res.status(403).json({ message: 'Access denied. User roles not found.' });
        }
        const hasRole = roles.some(role => req.user.roles.includes(role));
        if (!hasRole) {
            return res.status(403).json({ message: `Access denied. Requires one of roles: ${roles.join(', ')}.` });
        }
        next();
    };
};


// --- Validation Middleware ---
const validateRequest = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    next();
};

// --- Auth Routes ---
const authRouter = express.Router();

authRouter.post('/register',
    [
        body('name').trim().notEmpty().withMessage('Name is required.'),
        body('email').isEmail().withMessage('Valid email is required.').normalizeEmail(),
        body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters long.')
    ],
    validateRequest,
    async (req, res) => {
        const { name, email, password } = req.body;
        if (db.users.find(u => u.email === email)) {
            return res.status(400).json({ message: 'User with this email already exists.' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = {
            id: uuidv4(),
            name,
            email,
            passwordHash: hashedPassword,
            roles: ['user'], // Default role
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        db.users.push(newUser);
        // Initialize settings for the new user
        db.settings[newUser.id] = {
            companyName: `${name}'s Company`,
            companyAddress: "",
            companyLogoUrl: "",
            defaultCurrency: "USD",
            defaultTaxRate: 0,
            invoiceTemplate: "default"
        };
        console.log(`User registered: ${email}`);
        res.status(201).json({ message: 'User registered successfully.' });
    }
);

authRouter.post('/login',
    [
        body('email').isEmail().withMessage('Valid email is required.').normalizeEmail(),
        body('password').notEmpty().withMessage('Password is required.')
    ],
    validateRequest,
    async (req, res) => {
        const { email, password } = req.body;
        const user = db.users.find(u => u.email === email);
        if (!user) {
            return res.status(401).json({ message: 'Invalid email or password.' });
        }
        const isMatch = await bcrypt.compare(password, user.passwordHash);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid email or password.' });
        }
        const tokenPayload = { id: user.id, email: user.email, name: user.name, roles: user.roles };
        const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '1h' }); // Token expires in 1 hour

        console.log(`User logged in: ${email}`);
        res.json({
            message: 'Login successful.',
            token,
            user: { id: user.id, name: user.name, email: user.email, roles: user.roles }
        });
    }
);

authRouter.get('/status', authenticateToken, (req, res) => {
    // req.user is populated by authenticateToken middleware
    const user = db.users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ message: "User not found." });

    res.json({
        message: "Token is valid.",
        user: { id: user.id, name: user.name, email: user.email, roles: user.roles }
    });
});

authRouter.post('/logout', authenticateToken, (req, res) => {
    console.log(`User logged out: ${req.user.email}`);
    res.json({ message: 'Logged out successfully.' });
});

app.use('/api/auth', authRouter);

// --- User Settings Routes ---
const userRouter = express.Router();
userRouter.use(authenticateToken); // All user routes require authentication

userRouter.get('/me/settings', (req, res) => {
    const userSettings = db.settings[req.user.id];
    if (!userSettings) {
        // Initialize if somehow missing
        db.settings[req.user.id] = { companyName: `${req.user.name}'s Company`, companyAddress: "", companyLogoUrl: "", defaultCurrency: "USD", defaultTaxRate: 0, invoiceTemplate: "default" };
        return res.json(db.settings[req.user.id]);
    }
    res.json(userSettings);
});

userRouter.put('/me/settings',
    [
        body('companyName').optional({checkFalsy: true}).isString().trim(), // checkFalsy allows empty string
        body('companyAddress').optional({checkFalsy: true}).isString().trim(),
        body('companyLogoUrl').optional({checkFalsy: true}).isURL().withMessage('Invalid URL format for logo.'),
        body('defaultCurrency').optional().isString().isLength({ min: 3, max: 3 }).toUpperCase(),
        body('defaultTaxRate').optional().isFloat({ min: 0, max: 100 }),
        body('invoiceTemplate').optional().isString().isIn(['default', 'modern', 'classic'])
    ],
    validateRequest,
    (req, res) => {
        const currentSettings = db.settings[req.user.id] || {};
        const updatedSettings = { ...currentSettings };

        // Only update fields that are present in the request body
        if (req.body.companyName !== undefined) updatedSettings.companyName = req.body.companyName;
        if (req.body.companyAddress !== undefined) updatedSettings.companyAddress = req.body.companyAddress;
        if (req.body.companyLogoUrl !== undefined) updatedSettings.companyLogoUrl = req.body.companyLogoUrl;
        if (req.body.defaultCurrency !== undefined) updatedSettings.defaultCurrency = req.body.defaultCurrency;
        if (req.body.defaultTaxRate !== undefined) updatedSettings.defaultTaxRate = parseFloat(req.body.defaultTaxRate);
        if (req.body.invoiceTemplate !== undefined) updatedSettings.invoiceTemplate = req.body.invoiceTemplate;

        db.settings[req.user.id] = updatedSettings;
        console.log(`Settings updated for user: ${req.user.email}`);
        res.json(updatedSettings);
    }
);

app.use('/api/users', userRouter);


// --- Client Routes ---
const clientRouter = express.Router();
clientRouter.use(authenticateToken);

const clientValidationRules = [
    body('name').trim().notEmpty().withMessage('Client name is required.'),
    body('email').isEmail().withMessage('Valid client email is required.').normalizeEmail(),
    body('phone').optional({checkFalsy: true}).isString().trim(),
    body('address').optional({checkFalsy: true}).isString().trim(),
    body('notes').optional({checkFalsy: true}).isString().trim()
];

clientRouter.get('/', (req, res) => {
    const { search, page = 1, limit = 10 } = req.query;
    let userClients = db.clients.filter(c => c.userId === req.user.id);

    if (search) {
        const searchTerm = search.toLowerCase();
        userClients = userClients.filter(c =>
            c.name.toLowerCase().includes(searchTerm) ||
            c.email.toLowerCase().includes(searchTerm)
        );
    }

    const parsedPage = parseInt(page, 10);
    const parsedLimit = parseInt(limit, 10);
    const totalItems = userClients.length;
    const totalPages = Math.ceil(totalItems / parsedLimit);
    const startIndex = (parsedPage - 1) * parsedLimit;
    const endIndex = parsedPage * parsedLimit;
    const paginatedClients = userClients.slice(startIndex, endIndex);

    res.json({
        data: paginatedClients,
        pagination: {
            currentPage: parsedPage,
            totalPages,
            totalItems,
            limit: parsedLimit
        }
    });
});

clientRouter.post('/', clientValidationRules, validateRequest, (req, res) => {
    const { name, email, phone, address, notes } = req.body;
    const existingClient = db.clients.find(c => c.email === email && c.userId === req.user.id);
    if (existingClient) {
        return res.status(400).json({ message: 'Client with this email already exists for your account.' });
    }
    const newClient = {
        id: uuidv4(),
        userId: req.user.id,
        name, email, phone, address, notes,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    db.clients.push(newClient);
    console.log(`Client created for user ${req.user.email}: ${email}`);
    res.status(201).json(newClient);
});

clientRouter.get('/:id', [param('id').isUUID().withMessage('Invalid client ID format')], validateRequest, (req, res) => {
    const client = db.clients.find(c => c.id === req.params.id && c.userId === req.user.id);
    if (!client) return res.status(404).json({ message: 'Client not found or access denied.' });
    res.json(client);
});

clientRouter.put('/:id', [param('id').isUUID()], ...clientValidationRules, validateRequest, (req, res) => {
    const clientIndex = db.clients.findIndex(c => c.id === req.params.id && c.userId === req.user.id);
    if (clientIndex === -1) return res.status(404).json({ message: 'Client not found or access denied.' });

    const { name, email, phone, address, notes } = req.body;
    const updatedClient = {
        ...db.clients[clientIndex],
        name, email, phone, address, notes,
        updatedAt: new Date().toISOString(),
    };
    db.clients[clientIndex] = updatedClient;
    console.log(`Client updated for user ${req.user.email}: ${email}`);
    res.json(updatedClient);
});

clientRouter.delete('/:id', [param('id').isUUID()], validateRequest, (req, res) => {
    const initialLength = db.clients.length;
    db.clients = db.clients.filter(c => !(c.id === req.params.id && c.userId === req.user.id));
    if (db.clients.length === initialLength) {
        return res.status(404).json({ message: 'Client not found or access denied.' });
    }
    console.log(`Client deleted by user ${req.user.email}: ${req.params.id}`);
    res.status(204).send();
});

app.use('/api/clients', clientRouter);


// --- Invoice Routes ---
const invoiceRouter = express.Router();
invoiceRouter.use(authenticateToken);

const invoiceItemValidation = [
    body('items.*.description').trim().notEmpty().withMessage('Item description is required.'),
    body('items.*.quantity').isFloat({ gt: 0 }).withMessage('Item quantity must be a positive number.'),
    body('items.*.unit_price').isFloat({ min: 0 }).withMessage('Item unit price cannot be negative.'),
    body('items.*.tax_rate').optional().isFloat({ min: 0, max: 100 }).withMessage('Item tax rate must be between 0 and 100.')
];

const invoiceValidationRules = [
    body('client_id').isUUID().withMessage('Valid client ID is required.'),
    body('invoice_date').isISO8601().toDate().withMessage('Valid invoice date is required.'),
    body('due_date').optional({ checkFalsy: true }).isISO8601().toDate().withMessage('Valid due date is required if provided.'),
    body('status').isIn(['draft', 'pending', 'paid', 'partially_paid', 'overdue', 'cancelled']).withMessage('Invalid invoice status.'),
    body('notes').optional({checkFalsy: true}).isString(),
    body('currency').optional().isString().isLength({min:3, max:3}).toUpperCase(),
    body('global_tax_rate').optional().isFloat({ min: 0, max: 100 }),
    body('is_recurring').optional().isBoolean(),
    body('recurrence_frequency').optional().if(body('is_recurring').equals('true')).isIn(['daily', 'weekly', 'monthly', 'yearly', 'once']),
    body('recurrence_interval').optional().if(body('is_recurring').equals('true')).isInt({min:1}),
    body('recurrence_end_date').optional({ checkFalsy: true }).if(body('is_recurring').equals('true')).isISO8601().toDate(),
    body('items').isArray({ min: 1 }).withMessage('At least one item is required.'),
    ...invoiceItemValidation
];

invoiceRouter.get('/', (req, res) => {
    const { search, status, page = 1, limit = 10 } = req.query;
    let userInvoices = db.invoices.filter(inv => inv.userId === req.user.id).map(inv => {
        const client = db.clients.find(c => c.id === inv.clientId && c.userId === req.user.id);
        return { ...inv, client_name: client ? client.name : 'N/A', client_email: client ? client.email : 'N/A' };
    });

    if (search) {
        const searchTerm = search.toLowerCase();
        userInvoices = userInvoices.filter(inv =>
            (inv.invoice_number && inv.invoice_number.toLowerCase().includes(searchTerm)) ||
            (inv.client_name && inv.client_name.toLowerCase().includes(searchTerm))
        );
    }
    if (status) {
        userInvoices = userInvoices.filter(inv => inv.status === status);
    }

    userInvoices.sort((a, b) => new Date(b.invoice_date) - new Date(a.invoice_date));

    const parsedPage = parseInt(page, 10);
    const parsedLimit = parseInt(limit, 10);
    const totalItems = userInvoices.length;
    const totalPages = Math.ceil(totalItems / parsedLimit);
    const startIndex = (parsedPage - 1) * parsedLimit;
    const endIndex = parsedPage * parsedLimit;
    const paginatedInvoices = userInvoices.slice(startIndex, endIndex);

    res.json({
        data: paginatedInvoices,
        pagination: {
            currentPage: parsedPage,
            totalPages,
            totalItems,
            limit: parsedLimit
        }
    });
});

invoiceRouter.post('/', invoiceValidationRules, validateRequest, (req, res) => {
    const { client_id, items, ...invoiceData } = req.body;
    const client = db.clients.find(c => c.id === client_id && c.userId === req.user.id);
    if (!client) return res.status(404).json({ message: 'Client not found or access denied.' });

    let totalAmount = 0;
    items.forEach(item => {
        const itemSubtotal = Number(item.quantity) * Number(item.unit_price);
        const taxAmount = itemSubtotal * (Number(item.tax_rate || invoiceData.global_tax_rate || 0) / 100);
        totalAmount += itemSubtotal + taxAmount;
    });

    const newInvoice = {
        id: uuidv4(),
        userId: req.user.id,
        clientId: client_id,
        client_name: client.name,
        invoice_number: generateInvoiceNumber(),
        ...invoiceData,
        items,
        total_amount: parseFloat(totalAmount.toFixed(2)),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    db.invoices.push(newInvoice);
    console.log(`Invoice created by ${req.user.email}: ${newInvoice.invoice_number}`);
    res.status(201).json(newInvoice);
});

invoiceRouter.get('/:id', [param('id').isUUID()], validateRequest, (req, res) => {
    const invoice = db.invoices.find(inv => inv.id === req.params.id && inv.userId === req.user.id);
    if (!invoice) return res.status(404).json({ message: 'Invoice not found or access denied.' });

    const client = db.clients.find(c => c.id === invoice.clientId && c.userId === req.user.id);
    res.json({ ...invoice, client });
});

invoiceRouter.put('/:id', [param('id').isUUID()], ...invoiceValidationRules, validateRequest, (req, res) => {
    const invoiceIndex = db.invoices.findIndex(inv => inv.id === req.params.id && inv.userId === req.user.id);
    if (invoiceIndex === -1) return res.status(404).json({ message: 'Invoice not found or access denied.' });

    const { client_id, items, ...invoiceData } = req.body;
    const client = db.clients.find(c => c.id === client_id && c.userId === req.user.id);
    if (!client) return res.status(404).json({ message: 'Client not found or access denied for update.' });

    let totalAmount = 0;
    items.forEach(item => {
        const itemSubtotal = Number(item.quantity) * Number(item.unit_price);
        const taxAmount = itemSubtotal * (Number(item.tax_rate || invoiceData.global_tax_rate || 0) / 100);
        totalAmount += itemSubtotal + taxAmount;
    });

    const updatedInvoice = {
        ...db.invoices[invoiceIndex],
        clientId: client_id,
        client_name: client.name,
        ...invoiceData,
        items,
        total_amount: parseFloat(totalAmount.toFixed(2)),
        updatedAt: new Date().toISOString(),
    };
    db.invoices[invoiceIndex] = updatedInvoice;
    console.log(`Invoice updated by ${req.user.email}: ${updatedInvoice.invoice_number}`);
    res.json(updatedInvoice);
});

invoiceRouter.delete('/:id', [param('id').isUUID()], validateRequest, (req, res) => {
    const initialLength = db.invoices.length;
    db.invoices = db.invoices.filter(inv => !(inv.id === req.params.id && inv.userId === req.user.id));
    if (db.invoices.length === initialLength) {
        return res.status(404).json({ message: 'Invoice not found or access denied.' });
    }
    db.payments = db.payments.filter(p => p.invoiceId !== req.params.id);
    console.log(`Invoice deleted by ${req.user.email}: ${req.params.id}`);
    res.status(204).send();
});

invoiceRouter.get('/:id/pdf', [param('id').isUUID()], validateRequest, (req, res) => {
    const invoice = db.invoices.find(inv => inv.id === req.params.id && inv.userId === req.user.id);
    if (!invoice) return res.status(404).json({ message: 'Invoice not found or access denied.' });
    console.log(`PDF generation request for invoice ${invoice.invoice_number} by ${req.user.email}`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=invoice-${invoice.invoice_number}.pdf`);
    res.send(`PDF content for invoice ${invoice.invoice_number}`);
});

invoiceRouter.post('/:id/send-email', [param('id').isUUID()], validateRequest, (req, res) => {
    const invoice = db.invoices.find(inv => inv.id === req.params.id && inv.userId === req.user.id);
    if (!invoice) return res.status(404).json({ message: 'Invoice not found or access denied.' });
    console.log(`Email send request for invoice ${invoice.invoice_number} by ${req.user.email}`);
    res.json({ message: `Email for invoice ${invoice.invoice_number} would be sent here.` });
});

const paymentValidationRules = [
    body('amount').isFloat({ gt: 0 }).withMessage('Payment amount must be positive.'),
    body('payment_date').isISO8601().toDate().withMessage('Valid payment date is required.'),
    body('payment_method').trim().notEmpty().withMessage('Payment method is required.'),
    body('notes').optional({checkFalsy: true}).isString()
];

invoiceRouter.post('/:id/payments', [param('id').isUUID()], paymentValidationRules, validateRequest, (req, res) => {
    const invoiceId = req.params.id;
    const invoice = db.invoices.find(inv => inv.id === invoiceId && inv.userId === req.user.id);
    if (!invoice) return res.status(404).json({ message: 'Invoice not found or access denied.' });

    const { amount, payment_date, payment_method, notes } = req.body;
    const newPayment = {
        id: uuidv4(),
        invoiceId,
        userId: req.user.id,
        amount: parseFloat(amount),
        payment_date,
        payment_method,
        notes,
        createdAt: new Date().toISOString()
    };
    db.payments.push(newPayment);

    const totalPaid = db.payments.filter(p => p.invoiceId === invoiceId).reduce((sum, p) => sum + p.amount, 0);
    if (totalPaid >= invoice.total_amount) {
        invoice.status = 'paid';
    } else if (totalPaid > 0) {
        invoice.status = 'partially_paid';
    }
    invoice.updatedAt = new Date().toISOString();

    console.log(`Payment recorded for invoice ${invoice.invoice_number} by ${req.user.email}`);
    res.status(201).json(newPayment);
});

invoiceRouter.get('/:id/payments', [param('id').isUUID()], validateRequest, (req, res) => {
    const invoiceId = req.params.id;
    const invoice = db.invoices.find(inv => inv.id === invoiceId && inv.userId === req.user.id);
    if (!invoice) return res.status(404).json({ message: 'Invoice not found or access denied.' });

    const invoicePayments = db.payments.filter(p => p.invoiceId === invoiceId && p.userId === req.user.id);
    res.json({ data: invoicePayments });
});


app.use('/api/invoices', invoiceRouter);

// --- Reports Routes ---
const reportRouter = express.Router();
reportRouter.use(authenticateToken);

reportRouter.get('/summary', (req, res) => {
    const userInvoices = db.invoices.filter(inv => inv.userId === req.user.id);
    const now = new Date();
    const thirtyDaysAgo = new Date(new Date().setDate(now.getDate() - 30));

    let totalOutstanding = 0;
    let totalOverdue = 0;
    let paidLast30Days = 0;

    userInvoices.forEach(inv => {
        const paymentsForInvoice = db.payments.filter(p => p.invoiceId === inv.id);
        const totalPaidForInvoice = paymentsForInvoice.reduce((sum, p) => sum + p.amount, 0);
        const balanceDue = inv.total_amount - totalPaidForInvoice;

        if (balanceDue > 0 && (inv.status === 'pending' || inv.status === 'partially_paid' || inv.status === 'overdue')) {
            totalOutstanding += balanceDue;
            if (inv.due_date && new Date(inv.due_date) < now && inv.status !== 'paid' && inv.status !== 'cancelled') { // Exclude paid/cancelled from overdue
                totalOverdue += balanceDue;
            }
        }

        paymentsForInvoice.forEach(p => {
            if (new Date(p.payment_date) >= thirtyDaysAgo) {
                paidLast30Days += p.amount;
            }
        });
    });

    res.json({
        total_outstanding: parseFloat(totalOutstanding.toFixed(2)),
        total_overdue: parseFloat(totalOverdue.toFixed(2)),
        paid_last_30_days: parseFloat(paidLast30Days.toFixed(2)),
    });
});

reportRouter.get('/revenue-by-client', authorizeRole(['admin','user']), (req, res) => { // Example: Admin or user can see their own
    const targetUserId = req.user.roles.includes('admin') && req.query.userId ? req.query.userId : req.user.id; // Admin can query for a user

    const userClients = db.clients.filter(c => c.userId === targetUserId);
    const revenueData = userClients.map(client => {
        const clientInvoices = db.invoices.filter(inv => inv.clientId === client.id && inv.userId === targetUserId && (inv.status === 'paid' || inv.status === 'partially_paid'));
        const totalRevenueFromClient = clientInvoices.reduce((sum, inv) => {
            const paymentsForInvoice = db.payments.filter(p => p.invoiceId === inv.id);
            return sum + paymentsForInvoice.reduce((paySum, p) => paySum + p.amount, 0);
        }, 0);

        return {
            client_id: client.id,
            client_name: client.name,
            invoice_count: clientInvoices.length,
            total_revenue: parseFloat(totalRevenueFromClient.toFixed(2)),
        };
    }).filter(data => data.total_revenue > 0)
      .sort((a,b) => b.total_revenue - a.total_revenue);

    res.json({ data: revenueData });
});

app.use('/api/reports', reportRouter);


app.use((err, req, res, next) => {
    console.error("Unhandled error:", err.stack);
    res.status(500).json({ message: 'An internal server error occurred.' });
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log(`API base URL: http://localhost:${PORT}/api`);
    console.log('Loaded JWT_SECRET from .env file.');
    db.users.forEach(u => console.log(`- Test User Hint: ${u.email}`));
});