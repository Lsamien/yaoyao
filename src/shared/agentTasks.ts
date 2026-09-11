export interface TaskOrigin {
  conversationId: string
  conversationTaskId?: string
  runId: string
  agentId: string
}

export interface AgentGoal {
  id: string
  conversationId: string
  coordinatorId: string
  authorityRevision: number
  authorizationVersion?: number
  activation?: number
  objective: string
  acceptanceCriteria: string[]
  /** Changes only when acceptance criteria change, independently of progress. */
  acceptanceRevision?: number
  status: 'running' | 'review' | 'waiting' | 'blocked' | 'complete' | 'cancelling' | 'cancelled'
  origin: TaskOrigin
  result?: string
  checks?: Array<{ criterion: number; passed: boolean; evidence: string }>
  artifactIds: string[]
  revision: number
  automaticWakes: number
  reviewRunId?: string
  reportingRunId?: string
  lastReviewedBatch?: string
  createdAt: number
  updatedAt: number
}

export interface AgentAssignment {
  id: string
  goalId: string
  conversationId: string
  agentId: string
  title: string
  brief: string
  acceptanceCriteria: string[]
  dependsOn: string[]
  status: 'pending' | 'running' | 'review' | 'complete' | 'failed' | 'blocked' | 'cancelling' | 'cancelled'
  attempt: number
  maxAttempts?: number
  runId?: string
  result?: string
  review?: string
  artifactIds: string[]
  createdAt: number
  updatedAt: number
}

export interface TaskDelivery {
  id: string
  goalId: string
  kind: 'review' | 'terminal'
  status: 'pending' | 'delivered' | 'suppressed'
  targetConversationId: string
  targetTaskId?: string
  runId?: string
  createdAt: number
}
