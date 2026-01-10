import { useEffect, useRef } from "preact/hooks";

interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    children: preact.ComponentChildren;
}

export function BaseModal({ isOpen, onClose, title, children }: ModalProps) {
    const modalRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (isOpen && e.key === "Escape") {
                onClose();
            }
        };
        window.addEventListener("keydown", handleEscape);
        return () => window.removeEventListener("keydown", handleEscape);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    return (
        <div class="nv2-modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div class="nv2-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
                <div class="nv2-modal-header">
                    <h3 id="modal-title" class="nv2-modal-title">{title}</h3>
                    <button type="button" class="nv2-modal-close" onClick={onClose} aria-label="Close">
                        ×
                    </button>
                </div>
                <div class="nv2-modal-content">
                    {children}
                </div>
            </div>
        </div>
    );
}
