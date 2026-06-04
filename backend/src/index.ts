import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'

dotenv.config()

import buildsRouter from './routes/builds'
import mistakesRouter from './routes/mistakes'
import kpiRouter from './routes/kpi'
import reportsRouter from './routes/reports'
import settingsRouter from './routes/settings'
import plannerRouter from './routes/planner'
import qaRouter from './routes/qa'
import { authenticate, AuthRequest } from './middleware/auth'

const app = express()

app.use(cors({ origin: process.env.FRONTEND_URL ?? 'http://localhost:3000' }))
app.use(express.json())

app.get('/health', (_req, res) => res.json({ ok: true }))

app.get('/api/me', authenticate, (req: AuthRequest, res) => {
  res.json({ userId: req.userId, userRole: req.userRole })
})

app.use('/api/builds', buildsRouter)
app.use('/api/mistakes', mistakesRouter)
app.use('/api/kpi', kpiRouter)
app.use('/api/reports', reportsRouter)
app.use('/api/settings', settingsRouter)
app.use('/api/planner', plannerRouter)
app.use('/api/qa', qaRouter)

const PORT = process.env.PORT ?? 3001
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`))
