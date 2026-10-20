"""Authenticated Lingala text -> PCM WAV. Never log or persist submitted text."""
import logging
import os
import uuid

from flask import Flask, Response, jsonify, request
from werkzeug.exceptions import HTTPException

from access import AccessError
from text import speech_text


def create_app(engine=None, access=None):
    if engine is None:
        from engine import VoiceEngine
        engine = VoiceEngine(os.environ.get('VOICE_MODEL_DIR', '/app/model'),
                             int(os.environ.get('VOICE_THREADS', '2')))
    if access is None:
        from access import StudioAccess
        access = StudioAccess(os.environ.get('GOOGLE_CLOUD_PROJECT', 'koyokana-studio'))
    app = Flask(__name__)
    app.config['MAX_CONTENT_LENGTH'] = 4096

    @app.after_request
    def private(response):
        response.headers['Cache-Control'] = 'private, no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    @app.get('/healthz')
    def health():
        return jsonify(status='ready')

    @app.post('/api/voice/synthesize')
    def synthesize():
        uid = access.authorize(request.headers.get('Authorization', ''))
        body = request.get_json(silent=True)
        if not isinstance(body, dict) or set(body) != {'text'}:
            raise ValueError('Send a Lingala passage in the text field.')
        text = speech_text(body['text'], engine.vocab)
        access.reserve(uid)
        result = engine.speak(text)
        response = Response(result['wav'], mimetype='audio/wav')
        response.headers.update({
            'Content-Disposition': 'inline; filename="edmond-lingala.wav"',
            'X-Voice-Run': engine.provenance['run_id'],
            'X-Voice-Text': text,
            'X-Voice-Generation-Ms': str(result['generation_ms']),
            'X-Voice-Duration': str(result['duration']),
            'X-Voice-Cached': str(result['cached']).lower(),
            'X-Request-Id': uuid.uuid4().hex,
        })
        return response

    @app.errorhandler(AccessError)
    def denied(error):
        response = jsonify(error=str(error))
        response.status_code = error.status
        if error.retry_after:
            response.headers['Retry-After'] = str(error.retry_after)
        return response

    @app.errorhandler(ValueError)
    def invalid(error):
        return jsonify(error=str(error)), 400

    @app.errorhandler(HTTPException)
    def http_error(error):
        return jsonify(error='Request is too large.' if error.code == 413 else error.description), error.code

    @app.errorhandler(Exception)
    def failed(error):
        # Exception messages could contain submitted text or credentials. Log
        # only the type and request id, leaving browser requests private.
        request_id = uuid.uuid4().hex
        logging.error('voice_request_failed type=%s request_id=%s', type(error).__name__, request_id)
        return jsonify(error='Speech could not be generated. Please try again.', requestId=request_id), 503

    return app
