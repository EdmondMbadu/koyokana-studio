"""Server-side studio roles and persistent request limits."""
import datetime
import hashlib
import math
import os
import time

import firebase_admin
from firebase_admin import auth
from google.cloud import firestore


class AccessError(Exception):
    def __init__(self, message, status=401, retry_after=None):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


class StudioAccess:
    def __init__(self, project):
        firebase_admin.initialize_app(options={'projectId': project})
        self.db = firestore.Client(project=project)
        self.user_limit = int(os.environ.get('VOICE_USER_DAILY_LIMIT', '200'))
        self.global_limit = int(os.environ.get('VOICE_DAILY_LIMIT', '500'))

    def authorize(self, header):
        if not header.startswith('Bearer ') or len(header) > 8192:
            raise AccessError('Sign in to the studio to generate speech.')
        try:
            claims = auth.verify_id_token(header[7:])
        except (ValueError, auth.InvalidIdTokenError, auth.CertificateFetchError):
            raise AccessError('Your sign-in expired. Sign in again to generate speech.') from None
        uid = claims['uid']
        profile = self.db.collection('users').document(uid).get(timeout=10)
        if not profile.exists or profile.to_dict().get('role') != 'admin':
            raise AccessError('Voice generation is currently available to studio administrators.', 403)
        return uid

    def reserve(self, uid):
        now = time.time()
        utc = datetime.datetime.fromtimestamp(now, datetime.timezone.utc)
        day = utc.strftime('%Y%m%d')
        global_ref = self.db.collection('speechUsageDaily').document(day)
        user_ref = global_ref.collection('users').document(hashlib.sha256(uid.encode()).hexdigest())

        @firestore.transactional
        def reserve(transaction):
            total = global_ref.get(transaction=transaction).to_dict() or {}
            user = user_ref.get(transaction=transaction).to_dict() or {}
            if total.get('count', 0) >= self.global_limit or user.get('count', 0) >= self.user_limit:
                tomorrow = (utc + datetime.timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
                raise AccessError('The daily voice test allowance is used up. Try again tomorrow.', 429,
                                  math.ceil(tomorrow.timestamp() - now))
            if now - user.get('lastAt', 0) < 2:
                raise AccessError('Please wait a moment before generating again.', 429, 2)
            transaction.set(global_ref, {'count': total.get('count', 0) + 1, 'updatedAt': firestore.SERVER_TIMESTAMP})
            transaction.set(user_ref, {'count': user.get('count', 0) + 1, 'lastAt': now})

        reserve(self.db.transaction(max_attempts=3))
