import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'

dotenv.config()

import buildsRouter from './routes/builds'
import kpiRouter from './routes/kpi'
import reportsRouter from './routes/reports'
import settingsRouter from './routes/settings'
import qaRouter from './routes/qa'
import proofCorrectionsRouter from './routes/proof-corrections'
import translateRouter from './routes/translate'
import adminUsersRouter from './routes/admin-users'
import mondayRouter from './routes/monday'
import proofNotificationsRouter from './routes/proof-notifications'
import { authenticate, AuthRequest } from './middleware/auth'
import { supabase } from './supabase'
import { startNotificationScheduler } from './jobs/notificationScheduler'
import { startWaveReportCron } from './jobs/waveReportCron'
import { startWaveReportMonthlyCron } from './jobs/waveReportMonthlyCron'

const app = express()

app.use(cors({ origin: process.env.FRONTEND_URL ?? 'http://localhost:3000' }))
app.use(express.json())

app.get('/health', (_req, res) => res.json({ ok: true }))

app.get('/api/me', authenticate, async (req: AuthRequest, res) => {
  res.json({ userId: req.userId, userRole: req.userRole, userLang: req.userLang ?? null })
})

app.use('/api/builds', buildsRouter)
app.use('/api/kpi', kpiRouter)
app.use('/api/reports', reportsRouter)
app.use('/api/settings', settingsRouter)
app.use('/api/qa', qaRouter)
app.use('/api/proof-corrections', proofCorrectionsRouter)
app.use('/api/translate', translateRouter)
app.use('/api/admin/users', adminUsersRouter)
app.use('/api/monday', mondayRouter)
app.use('/api/proof-notifications', proofNotificationsRouter)

const PORT = process.env.PORT ?? 3001
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`)
  startNotificationScheduler()
  startWaveReportCron()
  startWaveReportMonthlyCron()
})
