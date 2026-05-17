// Central error handler — catches anything thrown in routes
function errorHandler(err, req, res, next) {
  console.error('API Error:', err.message)
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  })
}

module.exports = errorHandler
