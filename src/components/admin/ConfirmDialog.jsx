export default function ConfirmDialog({ message, onConfirm, onCancel }) {
  return (
    <div className="admin-modal-backdrop" onClick={onCancel}>
      <div className="admin-confirm-card" onClick={e => e.stopPropagation()}>
        <p className="admin-confirm-msg">{message}</p>
        <div className="admin-confirm-actions">
          <button className="btn-admin-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn-admin-danger" onClick={onConfirm}>Delete</button>
        </div>
      </div>
    </div>
  )
}
