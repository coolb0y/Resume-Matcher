"""TinyDB database layer for JSON storage."""

import asyncio
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from tinydb import Query, TinyDB
from tinydb.table import Table

from app.config import settings

logger = logging.getLogger(__name__)


class Database:
    """TinyDB wrapper for resume matcher data."""

    _master_resume_lock = asyncio.Lock()

    def __init__(self, db_path: Path | None = None):
        self.db_path = db_path or settings.db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._db: TinyDB | None = None

    @property
    def db(self) -> TinyDB:
        """Lazy initialization of TinyDB instance."""
        if self._db is None:
            self._db = TinyDB(self.db_path)
        return self._db

    @property
    def resumes(self) -> Table:
        """Resumes table."""
        return self.db.table("resumes")

    @property
    def jobs(self) -> Table:
        """Job descriptions table."""
        return self.db.table("jobs")

    @property
    def improvements(self) -> Table:
        """Improvement results table."""
        return self.db.table("improvements")

    @property
    def batches(self) -> Table:
        """Batch tailoring jobs table."""
        return self.db.table("batches")

    @property
    def batch_items(self) -> Table:
        """Batch tailoring items table."""
        return self.db.table("batch_items")

    @property
    def queue_items(self) -> Table:
        """Sequential queue items table."""
        return self.db.table("queue_items")

    def close(self) -> None:
        """Close database connection."""
        if self._db is not None:
            self._db.close()
            self._db = None

    # Resume operations
    def create_resume(
        self,
        content: str,
        content_type: str = "md",
        filename: str | None = None,
        is_master: bool = False,
        parent_id: str | None = None,
        processed_data: dict[str, Any] | None = None,
        processing_status: str = "pending",
        cover_letter: str | None = None,
        outreach_message: str | None = None,
        title: str | None = None,
        original_markdown: str | None = None,
    ) -> dict[str, Any]:
        """Create a new resume entry.

        processing_status: "pending", "processing", "ready", "failed"
        """
        resume_id = str(uuid4())
        now = datetime.now(timezone.utc).isoformat()

        doc: dict[str, Any] = {
            "resume_id": resume_id,
            "content": content,
            "content_type": content_type,
            "filename": filename,
            "is_master": is_master,
            "parent_id": parent_id,
            "processed_data": processed_data,
            "processing_status": processing_status,
            "cover_letter": cover_letter,
            "outreach_message": outreach_message,
            "title": title,
            "created_at": now,
            "updated_at": now,
        }
        if original_markdown is not None:
            doc["original_markdown"] = original_markdown
        self.resumes.insert(doc)
        return doc

    async def create_resume_atomic_master(
        self,
        content: str,
        content_type: str = "md",
        filename: str | None = None,
        processed_data: dict[str, Any] | None = None,
        processing_status: str = "pending",
        cover_letter: str | None = None,
        outreach_message: str | None = None,
        original_markdown: str | None = None,
    ) -> dict[str, Any]:
        """Create a new resume with atomic master assignment.

        Uses an asyncio.Lock to prevent race conditions when multiple uploads
        happen concurrently and both try to become master. This avoids blocking
        the FastAPI event loop unlike threading.Lock.
        """
        async with self._master_resume_lock:
            current_master = self.get_master_resume()
            is_master = current_master is None

            # Recovery behavior: if the current master is stuck in failed or
            # processing state, promote the next upload to become the new master.
            if current_master and current_master.get("processing_status") in ("failed", "processing"):
                Resume = Query()
                self.resumes.update(
                    {"is_master": False},
                    Resume.resume_id == current_master["resume_id"],
                )
                is_master = True

            return self.create_resume(
                content=content,
                content_type=content_type,
                filename=filename,
                is_master=is_master,
                processed_data=processed_data,
                processing_status=processing_status,
                cover_letter=cover_letter,
                outreach_message=outreach_message,
                original_markdown=original_markdown,
            )

    def get_resume(self, resume_id: str) -> dict[str, Any] | None:
        """Get resume by ID."""
        Resume = Query()
        result = self.resumes.search(Resume.resume_id == resume_id)
        return result[0] if result else None

    def get_master_resume(self) -> dict[str, Any] | None:
        """Get the master resume if exists."""
        Resume = Query()
        result = self.resumes.search(Resume.is_master == True)
        return result[0] if result else None

    def update_resume(self, resume_id: str, updates: dict[str, Any]) -> dict[str, Any]:
        """Update resume by ID.

        Raises:
            ValueError: If resume not found.
        """
        Resume = Query()
        updates["updated_at"] = datetime.now(timezone.utc).isoformat()
        updated_count = self.resumes.update(updates, Resume.resume_id == resume_id)

        if not updated_count:
            raise ValueError(f"Resume not found: {resume_id}")

        result = self.get_resume(resume_id)
        if not result:
            raise ValueError(f"Resume disappeared after update: {resume_id}")

        return result

    def delete_resume(self, resume_id: str) -> bool:
        """Delete resume by ID."""
        Resume = Query()
        removed = self.resumes.remove(Resume.resume_id == resume_id)
        return len(removed) > 0

    def list_resumes(self) -> list[dict[str, Any]]:
        """List all resumes."""
        return list(self.resumes.all())

    def set_master_resume(self, resume_id: str) -> bool:
        """Set a resume as the master, unsetting any existing master.

        Returns False if the resume doesn't exist.
        """
        Resume = Query()

        # First verify the target resume exists
        target = self.resumes.search(Resume.resume_id == resume_id)
        if not target:
            logger.warning("Cannot set master: resume %s not found", resume_id)
            return False

        # Unset current master
        self.resumes.update({"is_master": False}, Resume.is_master == True)
        # Set new master
        updated = self.resumes.update(
            {"is_master": True}, Resume.resume_id == resume_id
        )
        return len(updated) > 0

    # Job operations
    def create_job(self, content: str, resume_id: str | None = None) -> dict[str, Any]:
        """Create a new job description entry."""
        job_id = str(uuid4())
        now = datetime.now(timezone.utc).isoformat()

        doc = {
            "job_id": job_id,
            "content": content,
            "resume_id": resume_id,
            "created_at": now,
        }
        self.jobs.insert(doc)
        return doc

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        """Get job by ID."""
        Job = Query()
        result = self.jobs.search(Job.job_id == job_id)
        return result[0] if result else None

    def update_job(self, job_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        """Update a job by ID."""
        Job = Query()
        updated = self.jobs.update(updates, Job.job_id == job_id)
        if not updated:
            return None
        return self.get_job(job_id)

    # Improvement operations
    def create_improvement(
        self,
        original_resume_id: str,
        tailored_resume_id: str,
        job_id: str,
        improvements: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Create an improvement result entry."""
        request_id = str(uuid4())
        now = datetime.now(timezone.utc).isoformat()

        doc = {
            "request_id": request_id,
            "original_resume_id": original_resume_id,
            "tailored_resume_id": tailored_resume_id,
            "job_id": job_id,
            "improvements": improvements,
            "created_at": now,
        }
        self.improvements.insert(doc)
        return doc

    def get_improvement_by_tailored_resume(
        self, tailored_resume_id: str
    ) -> dict[str, Any] | None:
        """Get improvement record by tailored resume ID.

        This is used to retrieve the job context for on-demand
        cover letter and outreach message generation.
        """
        Improvement = Query()
        result = self.improvements.search(
            Improvement.tailored_resume_id == tailored_resume_id
        )
        return result[0] if result else None

    # Batch operations
    def create_batch(
        self,
        batch_id: str,
        resume_id: str,
        total_items: int,
        rate_limit_seconds: float = 5.0,
        prompt_id: str | None = None,
    ) -> dict[str, Any]:
        """Create a new batch record."""
        now = datetime.now(timezone.utc).isoformat()
        doc = {
            "batch_id": batch_id,
            "resume_id": resume_id,
            "total_jobs": total_items,
            "completed_jobs": 0,
            "failed_jobs": 0,
            "status": "queued",
            "rate_limit_seconds": rate_limit_seconds,
            "prompt_id": prompt_id,
            "created_at": now,
            "updated_at": now,
        }
        self.batches.insert(doc)
        return doc

    def create_batch_item(
        self,
        item_id: str,
        batch_id: str,
        resume_id: str,
        job_description: str,
        index: int,
        prompt_id: str | None = None,
    ) -> dict[str, Any]:
        """Create an individual item in a batch."""
        now = datetime.now(timezone.utc).isoformat()
        doc = {
            "item_id": item_id,
            "batch_id": batch_id,
            "resume_id": resume_id,
            "job_description": job_description,
            "index": index,
            "prompt_id": prompt_id,
            "status": "pending",
            "job_id": None,
            "tailored_resume_id": None,
            "error": None,
            "created_at": now,
            "updated_at": now,
        }
        self.batch_items.insert(doc)
        return doc

    def get_batch(self, batch_id: str) -> dict[str, Any] | None:
        """Get batch by ID."""
        Batch = Query()
        result = self.batches.search(Batch.batch_id == batch_id)
        return result[0] if result else None

    def get_batch_items(self, batch_id: str) -> list[dict[str, Any]]:
        """Get all items for a batch, sorted by index."""
        Item = Query()
        items = self.batch_items.search(Item.batch_id == batch_id)
        return sorted(items, key=lambda x: x.get("index", 0))

    def update_batch(self, batch_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        """Update a batch record."""
        Batch = Query()
        updates["updated_at"] = datetime.now(timezone.utc).isoformat()
        updated = self.batches.update(updates, Batch.batch_id == batch_id)
        if not updated:
            return None
        return self.get_batch(batch_id)

    def update_batch_item(self, item_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        """Update an item in a batch."""
        Item = Query()
        updates["updated_at"] = datetime.now(timezone.utc).isoformat()
        updated = self.batch_items.update(updates, Item.item_id == item_id)
        if not updated:
            return None
        result = self.batch_items.search(Item.item_id == item_id)
        return result[0] if result else None

    def list_batches(self, limit: int = 50) -> list[dict[str, Any]]:
        """List all batches ordered by created_at descending."""
        batches = list(self.batches.all())
        batches.sort(key=lambda b: b.get("created_at", ""), reverse=True)
        return batches[:limit]

    # Queue operations
    def create_queue_item(
        self,
        item_id: str,
        resume_id: str,
        job_description: str,
        role: str = "",
        company: str = "",
        job_req_id: str = "",
        rate_limit_seconds: float = 5.0,
        prompt_id: str | None = None,
    ) -> dict[str, Any]:
        """Create a new queue item."""
        now = datetime.now(timezone.utc).isoformat()
        doc = {
            "item_id": item_id,
            "resume_id": resume_id,
            "job_description": job_description,
            "role": role,
            "company": company,
            "job_req_id": job_req_id,
            "status": "pending",
            "job_id": None,
            "tailored_resume_id": None,
            "title": None,
            "error": None,
            "rate_limit_seconds": rate_limit_seconds,
            "prompt_id": prompt_id,
            "created_at": now,
            "updated_at": now,
        }
        self.queue_items.insert(doc)
        return doc

    def get_queue_item(self, item_id: str) -> dict[str, Any] | None:
        """Get a queue item by ID."""
        Item = Query()
        result = self.queue_items.search(Item.item_id == item_id)
        return result[0] if result else None

    def get_queue(
        self, resume_id: str | None = None, limit: int = 50
    ) -> list[dict[str, Any]]:
        """Get queue items ordered by created_at descending."""
        Item = Query()
        if resume_id:
            items = self.queue_items.search(Item.resume_id == resume_id)
        else:
            items = list(self.queue_items.all())
        items.sort(key=lambda x: x.get("created_at", ""), reverse=True)
        return items[:limit]

    def update_queue_item(
        self, item_id: str, updates: dict[str, Any]
    ) -> dict[str, Any] | None:
        """Update a queue item by ID."""
        Item = Query()
        updates["updated_at"] = datetime.now(timezone.utc).isoformat()
        updated = self.queue_items.update(updates, Item.item_id == item_id)
        if not updated:
            return None
        return self.get_queue_item(item_id)

    def delete_queue_item(self, item_id: str) -> bool:
        """Delete a queue item by ID."""
        Item = Query()
        removed = self.queue_items.remove(Item.item_id == item_id)
        return len(removed) > 0

    def clear_queue(self, status: str | None = None) -> int:
        """Clear queue items by status or all."""
        Item = Query()
        if status:
            removed = self.queue_items.remove(Item.status == status)
            return len(removed)
        total = len(self.queue_items)
        self.queue_items.truncate()
        return total

    # Stats
    def get_stats(self) -> dict[str, Any]:
        """Get database statistics."""
        return {
            "total_resumes": len(self.resumes),
            "total_jobs": len(self.jobs),
            "total_improvements": len(self.improvements),
            "has_master_resume": self.get_master_resume() is not None,
        }

    def reset_database(self) -> None:
        """Reset the database by truncating all tables and clearing uploads."""
        # Truncate tables
        self.resumes.truncate()
        self.jobs.truncate()
        self.improvements.truncate()
        self.batches.truncate()
        self.batch_items.truncate()
        self.queue_items.truncate()

        # Clear uploads directory
        uploads_dir = settings.data_dir / "uploads"
        if uploads_dir.exists():
            import shutil

            shutil.rmtree(uploads_dir)
            uploads_dir.mkdir(parents=True, exist_ok=True)


# Global database instance
db = Database()
