-- Retain shift definitions and all dated assignment history when disabled.
ALTER TABLE housekeeping_shifts ADD COLUMN active boolean NOT NULL DEFAULT true;
