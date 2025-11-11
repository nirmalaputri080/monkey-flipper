-- Migration: Add position tracking fields to duels table
-- Run this SQL on your PostgreSQL database to add new columns

-- Add position and status tracking columns
ALTER TABLE duels 
ADD COLUMN IF NOT EXISTS player1_x FLOAT,
ADD COLUMN IF NOT EXISTS player1_y FLOAT,
ADD COLUMN IF NOT EXISTS player2_x FLOAT,
ADD COLUMN IF NOT EXISTS player2_y FLOAT,
ADD COLUMN IF NOT EXISTS player1_alive BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS player2_alive BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS player1_last_update TIMESTAMP,
ADD COLUMN IF NOT EXISTS player2_last_update TIMESTAMP;

-- Verify the new columns
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'duels'
AND column_name IN ('player1_x', 'player1_y', 'player2_x', 'player2_y', 
                    'player1_alive', 'player2_alive', 
                    'player1_last_update', 'player2_last_update');
