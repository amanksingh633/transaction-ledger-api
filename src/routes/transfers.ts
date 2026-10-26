import { Router } from 'express';
import { createTransferBody, parseBody } from '../lib/validation';
import { createTransfer } from '../services/transfers';

export const transfersRouter = Router();

// POST /transfers
transfersRouter.post('/', async (req, res) => {
  res.status(201).json(await createTransfer(parseBody(createTransferBody, req.body)));
});
